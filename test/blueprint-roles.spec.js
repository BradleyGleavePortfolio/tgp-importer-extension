import { describe, expect, it } from "vitest";
import { normalizeCaptureSnapshot } from "../shared/blueprint/input.js";
import {
  COLLISION_REASON,
  DYNAMIC_KEY_REASON,
  inferEndpointRoles,
  KEY_SLOT_REASON,
  ROLE_HARD_LIMITS,
  SESSION_SLOT_REASON,
} from "../shared/blueprint/roles.js";
import { inferUrlTemplates } from "../shared/blueprint/url-templates.js";
import {
  extractItems,
  normalizeBlueprint,
} from "../shared/replay/blueprint.js";

const ORIGIN = "https://coach.example";

function observation(path, body, overrides = {}) {
  return {
    origin: ORIGIN,
    path,
    queryKeys: [],
    method: "GET",
    status: 200,
    capturedAt: null,
    headers: {},
    body,
    ...overrides,
  };
}

function cluster(pathPattern, observations, overrides = {}) {
  const dynamicSegments = pathPattern
    .split("/")
    .filter((segment) => segment === ":id").length;
  return {
    origin: ORIGIN,
    method: "GET",
    pathPattern,
    dynamicSegments,
    replayCompatible: dynamicSegments <= 1,
    queryKeys: [],
    observations,
    ...overrides,
  };
}

function nest(keys, value) {
  return keys.length === 0 ? value : { [keys[0]]: nest(keys.slice(1), value) };
}

function item(index) {
  return { id: index, name: `row-${index}`, active: true };
}

function listBodies(path, count, keys = []) {
  return Array.from({ length: count }, (_unused, index) =>
    observation(path, { data: { items: [item(index)] } }, { queryKeys: keys }),
  );
}

// Value-free typed items-path steps (C2B1-SOL2-A1): key slots numbered left to
// right, and a dynamic-key marker for a map-shaped level.
const K = (n) => ({ type: "key", slot: `k${n}` });
const DYN = { type: "dynamic_key" };
const keyed = (count) => Array.from({ length: count }, (_u, i) => K(i + 1));

function only(result) {
  expect(result.refused).toEqual([]);
  expect(result.candidates).toHaveLength(1);
  return result.candidates[0];
}

function onlyRefusal(result) {
  expect(result.candidates).toEqual([]);
  expect(result.refused).toHaveLength(1);
  return result.refused[0];
}

describe("inferEndpointRoles — collection evidence", () => {
  it("reads a root body array as a list rooted at the body itself", () => {
    const rows = [
      observation("/clients", [item(1), item(2)]),
      observation("/clients", [item(3)]),
    ];
    const candidate = only(inferEndpointRoles(rows, [cluster("/clients", 2)]));
    // A lone zero-dynamic template is unproven structure (C2b-2 may prove it).
    expect(candidate).toEqual({
      endpoint: { origin: ORIGIN, method: "GET", template: null },
      roles: ["list"],
      itemsPath: [],
      itemShape: "object{boolean*1,number*1,string*1}",
      support: 2,
      windowEvidence: null,
      paginationEvidence: null,
      replayCompatible: false,
      reasons: ["unproven_template_literal"],
    });
  });

  it("locates exactly one nested entity array beside wrapper metadata", () => {
    const rows = [
      observation("/clients", {
        data: { items: [item(1)], generatedIn: 12 },
        meta: { total: 1 },
      }),
    ];
    const candidate = only(inferEndpointRoles(rows, [cluster("/clients", 1)]));
    expect(candidate.roles).toEqual(["list"]);
    expect(candidate.itemsPath).toEqual([K(1), K(2)]);
    expect(candidate.reasons).toEqual([
      KEY_SLOT_REASON,
      "unproven_template_literal",
    ]);
  });

  it("classifies a dynamic template with a singleton object as a detail", () => {
    const rows = [
      observation("/clients/101", item(1)),
      observation("/clients/102", item(2)),
      observation("/clients/103", item(3)),
    ];
    const candidate = only(
      inferEndpointRoles(rows, [cluster("/clients/:id", 3)]),
    );
    expect(candidate.roles).toEqual(["detail"]);
    expect(candidate.itemsPath).toBeNull();
    expect(candidate.itemShape).toBe("object{boolean*1,number*1,string*1}");
    expect(candidate.replayCompatible).toBe(false);
    expect(candidate.reasons).toEqual([
      "detail_body_not_representable",
      "session_slot_rebinding_required",
    ]);
  });

  it("classifies a dynamic template returning arrays as a list, not a detail", () => {
    const rows = [
      observation("/clients/101/workouts", { items: [item(1)] }),
      observation("/clients/102/workouts", { items: [item(2)] }),
    ];
    const candidate = only(
      inferEndpointRoles(rows, [cluster("/clients/:id/workouts", 2)]),
    );
    expect(candidate.roles).toEqual(["list"]);
    expect(candidate.itemsPath).toEqual([K(1)]);
    // Both literals are session slots: listed, but not replayable yet (A1).
    expect(candidate.endpoint.template).toBe("/:s1/:id/:s2");
    expect(candidate.replayCompatible).toBe(false);
    expect(candidate.reasons).toEqual([
      KEY_SLOT_REASON,
      "session_slot_rebinding_required",
    ]);
  });

  it("refuses a static singleton object as metadata rather than a detail", () => {
    const rows = [observation("/settings", { locale: "en", theme: "dark" })];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/settings", 1)])),
    ).toEqual({
      endpoint: { origin: ORIGIN, method: "GET", template: null },
      reason: "metadata_only",
      support: 1,
    });
  });

  it("treats an array of scalars as insufficient entity evidence", () => {
    const rows = [observation("/tags", { tags: ["a", "b"] })];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/tags", 1)])).reason,
    ).toBe("metadata_only");
  });
});

describe("inferEndpointRoles — window evidence", () => {
  it.each([
    ["from", "to"],
    ["since", "until"],
    ["start", "end"],
  ])("accepts the consistent %s/%s window pair", (lower, upper) => {
    const candidate = only(
      inferEndpointRoles(listBodies("/sessions", 2, [lower, upper]), [
        cluster("/sessions", 2),
      ]),
    );
    expect(candidate.roles).toEqual(["list", "windowed"]);
    expect(candidate.windowEvidence).toEqual({ lower, upper });
    expect(candidate.replayCompatible).toBe(false);
    expect(candidate.reasons).toEqual([
      KEY_SLOT_REASON,
      "unproven_template_literal",
      "window_not_representable",
    ]);
  });

  it.each([["from"], ["to"], ["since"], ["start"], ["end"]])(
    "refuses the window modifier for the lone key %s",
    (key) => {
      const candidate = only(
        inferEndpointRoles(listBodies("/sessions", 2, [key]), [
          cluster("/sessions", 2),
        ]),
      );
      expect(candidate.roles).toEqual(["list"]);
      expect(candidate.windowEvidence).toBeNull();
    },
  );

  it("refuses a window when two different pairs co-occur", () => {
    const candidate = only(
      inferEndpointRoles(
        listBodies("/sessions", 2, ["from", "to", "since", "until"]),
        [cluster("/sessions", 2)],
      ),
    );
    expect(candidate.windowEvidence).toBeNull();
    expect(candidate.reasons).toContain("ambiguous_window_keys");
    expect(candidate.replayCompatible).toBe(false);
  });

  it("does not combine window halves observed on different requests", () => {
    const rows = [
      ...listBodies("/sessions", 1, ["from"]),
      ...listBodies("/sessions", 1, ["to"]),
    ];
    const candidate = only(inferEndpointRoles(rows, [cluster("/sessions", 2)]));
    expect(candidate.windowEvidence).toBeNull();
    expect(candidate.roles).toEqual(["list"]);
  });
});

describe("inferEndpointRoles — pagination evidence", () => {
  it.each([["page"], ["offset"]])("records %s as page evidence", (key) => {
    const candidate = only(
      inferEndpointRoles(listBodies("/clients", 2, [key, "limit"]), [
        cluster("/clients", 2),
      ]),
    );
    expect(candidate.roles).toEqual(["list", "paginated"]);
    expect(candidate.paginationEvidence).toEqual({
      styles: ["page"],
      queryKeys: [key, "limit"].sort(),
    });
    expect(candidate.reasons).toEqual([
      "pagination_descriptor_required",
      KEY_SLOT_REASON,
      "unproven_template_literal",
    ]);
    expect(candidate.replayCompatible).toBe(false);
  });

  it("records cursor evidence for a cursor query name", () => {
    const candidate = only(
      inferEndpointRoles(listBodies("/clients", 2, ["cursor", "per_page"]), [
        cluster("/clients", 2),
      ]),
    );
    expect(candidate.paginationEvidence).toEqual({
      styles: ["cursor"],
      queryKeys: ["cursor", "per_page"],
    });
  });

  it.each([["limit"], ["per_page"]])(
    "does not mark an endpoint paginated for %s alone",
    (key) => {
      const candidate = only(
        inferEndpointRoles(listBodies("/clients", 2, [key]), [
          cluster("/clients", 2),
        ]),
      );
      expect(candidate.roles).toEqual(["list"]);
      expect(candidate.paginationEvidence).toBeNull();
      expect(candidate.reasons).toEqual([
        KEY_SLOT_REASON,
        "unproven_template_literal",
      ]);
    },
  );

  it.each([["after"], ["before"]])(
    "records %s as ambiguity rather than cursor proof",
    (key) => {
      const candidate = only(
        inferEndpointRoles(listBodies("/clients", 2, [key, "limit"]), [
          cluster("/clients", 2),
        ]),
      );
      expect(candidate.paginationEvidence).toBeNull();
      expect(candidate.roles).toEqual(["list"]);
      expect(candidate.reasons).toEqual([
        "ambiguous_cursor_keys",
        KEY_SLOT_REASON,
        "unproven_template_literal",
      ]);
      expect(candidate.replayCompatible).toBe(false);
    },
  );

  it("keeps the list but refuses runnability when page and cursor mix", () => {
    const candidate = only(
      inferEndpointRoles(listBodies("/clients", 2, ["page", "cursor"]), [
        cluster("/clients", 2),
      ]),
    );
    expect(candidate.roles).toEqual(["list", "paginated"]);
    expect(candidate.paginationEvidence.styles).toEqual(["cursor", "page"]);
    expect(candidate.reasons).toEqual([
      "ambiguous_pagination_style",
      "pagination_descriptor_required",
      KEY_SLOT_REASON,
      "unproven_template_literal",
    ]);
    expect(candidate.replayCompatible).toBe(false);
  });

  it("ignores query names outside the supported C2a vocabulary", () => {
    const candidate = only(
      inferEndpointRoles(
        listBodies("/clients", 2, ["sort", "q", "client_id"]),
        [cluster("/clients", 2)],
      ),
    );
    expect(candidate.paginationEvidence).toBeNull();
    expect(candidate.windowEvidence).toBeNull();
    expect(candidate.reasons).toEqual([
      KEY_SLOT_REASON,
      "unproven_template_literal",
    ]);
  });
});

describe("inferEndpointRoles — contradiction refusals", () => {
  it("refuses two competing entity-array paths in one body", () => {
    const rows = [
      observation("/dashboard", {
        clients: [item(1)],
        workouts: [item(2)],
      }),
    ];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/dashboard", 1)])).reason,
    ).toBe("ambiguous_items_path");
  });

  it("refuses two competing empty collections in one body", () => {
    const rows = [observation("/dashboard", { clients: [], workouts: [] })];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/dashboard", 1)])).reason,
    ).toBe("ambiguous_items_path");
  });

  it("refuses when observations disagree about the items path", () => {
    const rows = [
      observation("/clients", { data: [item(1)] }),
      observation("/clients", { rows: [item(2)] }),
    ];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/clients", 2)])).reason,
    ).toBe("inconsistent_items_path");
  });

  it("refuses when observations disagree about the item shape", () => {
    const rows = [
      observation("/clients", { data: [item(1)] }),
      observation("/clients", { data: [{ id: 2 }] }),
    ];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/clients", 2)])).reason,
    ).toBe("inconsistent_item_shape");
  });

  it("refuses a single array mixing objects and scalars", () => {
    const rows = [observation("/clients", { data: [item(1), "orphan"] })];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/clients", 1)])).reason,
    ).toBe("inconsistent_item_shape");
  });

  it("refuses when a list body and a singleton body claim one endpoint", () => {
    const rows = [
      observation("/clients/101", { data: [item(1)] }),
      observation("/clients/102", item(2)),
    ];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/clients/:id", 2)]))
        .reason,
    ).toBe("inconsistent_role_evidence");
  });

  it.each([
    ["all-empty collections", { data: [] }],
    ["a scalar body", 7],
    ["a null body", null],
    ["a string body", "ok"],
  ])("refuses insufficient shape evidence for %s", (_label, body) => {
    const rows = [observation("/clients", body)];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/clients", 1)])).reason,
    ).toBe("insufficient_shape_evidence");
  });

  it("accepts a list when only some observations are empty pages", () => {
    const rows = [
      observation("/clients", { data: [item(1)] }),
      observation("/clients", { data: [] }),
    ];
    const candidate = only(inferEndpointRoles(rows, [cluster("/clients", 2)]));
    expect(candidate.itemsPath).toEqual([K(1)]);
    expect(candidate.support).toBe(2);
  });
});

describe("inferEndpointRoles — template join", () => {
  it("prefers an exact literal template over an overlapping dynamic one", () => {
    const rows = [
      observation("/clients/archived", { data: [item(1)] }),
      observation("/clients/101", item(2)),
      observation("/clients/102", item(3)),
    ];
    const result = inferEndpointRoles(rows, [
      cluster("/clients/archived", 1),
      cluster("/clients/:id", 2),
    ]);
    expect(result.refused).toEqual([]);
    // "archived" joins only its literal template, so :id keeps support 2; the
    // lone literal template itself stays unproven and withheld.
    expect(
      result.candidates.map((entry) => [
        entry.endpoint.template,
        entry.roles.join("+"),
        entry.support,
      ]),
    ).toEqual([
      ["/:s1/:id", "detail", 2],
      [null, "list", 1],
    ]);
  });

  it("refuses membership when two templates match equally well", () => {
    const rows = [observation("/clients", { data: [item(1)] })];
    const result = inferEndpointRoles(rows, [
      cluster("/clients", 1),
      cluster("/clients", 1, { queryKeys: ["page"] }),
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.refused.map((entry) => entry.reason)).toEqual([
      "ambiguous_template_membership",
      "ambiguous_template_membership",
    ]);
  });

  it("reports observations that no supplied template describes", () => {
    const rows = [observation("/unknown/1234", { data: [item(1)] })];
    const result = inferEndpointRoles(rows, [cluster("/clients", 0)]);
    expect(result.candidates).toEqual([]);
    // The declared-but-unobserved template is refused on its own account.
    expect(result.refused).toEqual([
      {
        endpoint: { origin: ORIGIN, method: "GET", template: null },
        reason: "no_successful_get_evidence",
        support: 0,
      },
      {
        endpoint: { origin: ORIGIN, method: "GET", template: null },
        reason: "unmatched_observation",
        support: 1,
      },
    ]);
  });

  it("refuses a cluster whose declared support disagrees with the join", () => {
    const rows = [observation("/clients", { data: [item(1)] })];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/clients", 4)])),
    ).toEqual({
      endpoint: { origin: ORIGIN, method: "GET", template: null },
      reason: "template_support_mismatch",
      support: 1,
    });
  });

  it("refuses a template with more than one dynamic segment", () => {
    const rows = [
      observation("/clients/101/workouts/20001", { data: [item(1)] }),
    ];
    expect(
      onlyRefusal(
        inferEndpointRoles(rows, [cluster("/clients/:id/workouts/:id", 1)]),
      ).reason,
    ).toBe("template_not_replayable");
  });

  it("does not join an observation to another origin or method", () => {
    const rows = [
      observation("/clients", { data: [item(1)] }, { origin: ORIGIN }),
    ];
    const result = inferEndpointRoles(rows, [
      cluster("/clients", 1, { origin: "https://other.example" }),
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.refused.map((entry) => entry.reason).sort()).toEqual([
      "template_support_mismatch",
      "unmatched_observation",
    ]);
  });
});

describe("inferEndpointRoles — status and method discipline", () => {
  it("does not let a HEAD observation determine a role", () => {
    const rows = [
      observation("/clients", { data: [item(1)] }, { method: "HEAD" }),
    ];
    expect(
      onlyRefusal(
        inferEndpointRoles(rows, [
          cluster("/clients", 1, { method: "HEAD", replayCompatible: true }),
        ]),
      ).reason,
    ).toBe("no_successful_get_evidence");
  });

  it.each([[301], [401], [404], [500]])(
    "does not let a %s body determine a role",
    (status) => {
      const rows = [observation("/clients", { data: [item(1)] }, { status })];
      expect(
        onlyRefusal(inferEndpointRoles(rows, [cluster("/clients", 1)])).reason,
      ).toBe("no_successful_get_evidence");
    },
  );

  it("ignores an error body while a successful body still votes", () => {
    const rows = [
      observation("/clients", { data: [item(1)] }),
      observation("/clients", { error: "denied" }, { status: 403 }),
    ];
    const candidate = only(inferEndpointRoles(rows, [cluster("/clients", 2)]));
    expect(candidate.support).toBe(1);
    expect(candidate.itemsPath).toEqual([K(1)]);
  });
});

describe("inferEndpointRoles — bounds", () => {
  it("returns hard ceilings that never exceed the C2a observation ceiling", () => {
    expect(ROLE_HARD_LIMITS).toEqual({
      maxObservations: 1000,
      maxDepth: 4,
      maxCandidateArrays: 16,
    });
  });

  it.each([
    [3, true],
    [4, true],
    [5, false],
  ])("handles %i observations against a limit of 4", (count, accepted) => {
    const rows = listBodies("/clients", count);
    const result = inferEndpointRoles(rows, [cluster("/clients", count)], {
      maxObservations: 4,
    });
    if (accepted) {
      expect(only(result).support).toBe(count);
    } else {
      expect(onlyRefusal(result)).toEqual({
        endpoint: null,
        reason: "observation_limit",
        support: count,
      });
    }
  });

  it.each([
    [1, ["a"]],
    [2, ["a", "b"]],
    [3, ["a", "b", "c"]],
  ])(
    "finds an array nested %i keys deep under a depth limit of 2",
    (depth, keys) => {
      const body = nest(keys, [item(1)]);
      const result = inferEndpointRoles(
        [observation("/clients", body)],
        [cluster("/clients", 1)],
        { maxDepth: 2 },
      );
      if (depth <= 2) expect(only(result).itemsPath).toEqual(keyed(depth));
      else expect(onlyRefusal(result).reason).toBe("metadata_only");
    },
  );

  it.each([
    [1, true],
    [2, true],
    [3, false],
  ])("tolerates %i candidate arrays under a limit of 2", (count, accepted) => {
    const body = Object.fromEntries(
      Array.from({ length: count }, (_unused, index) => [`k${index}`, []]),
    );
    body.k0 = [item(1)];
    const result = inferEndpointRoles(
      [observation("/clients", body)],
      [cluster("/clients", 1)],
      { maxCandidateArrays: 2 },
    );
    const reason = accepted ? null : "candidate_array_limit";
    if (accepted) expect(only(result).itemsPath).toEqual([K(1)]);
    else expect(onlyRefusal(result).reason).toBe(reason);
  });

  it("refuses more clusters than the observation ceiling allows", () => {
    const clusters = Array.from({ length: 3 }, (_unused, index) =>
      cluster(`/c${index}`, 0),
    );
    expect(
      onlyRefusal(inferEndpointRoles([], clusters, { maxObservations: 2 })),
    ).toEqual({ endpoint: null, reason: "cluster_limit", support: 3 });
  });

  it.each([
    ["observations", "not-an-array", []],
    ["clusters", [], "not-an-array"],
  ])("refuses invalid %s input", (_label, rows, clusters) => {
    expect(onlyRefusal(inferEndpointRoles(rows, clusters))).toEqual({
      endpoint: null,
      reason: "invalid_input",
      support: 0,
    });
  });

  it("clamps an over-large option request to the hard ceiling", () => {
    const rows = listBodies("/clients", 2);
    const candidate = only(
      inferEndpointRoles(rows, [cluster("/clients", 2)], {
        maxObservations: 10 ** 6,
        maxDepth: 99,
        maxCandidateArrays: 0,
      }),
    );
    expect(candidate.support).toBe(2);
  });
});

describe("inferEndpointRoles — determinism", () => {
  it("emits byte-identical output for every capture permutation", () => {
    const rows = [
      observation("/clients", { data: [item(1)] }, { queryKeys: ["page"] }),
      observation("/clients", { data: [item(2)] }),
      observation("/clients/101", item(1)),
      observation(
        "/sessions",
        { data: [item(3)] },
        { queryKeys: ["from", "to"] },
      ),
    ];
    const clusters = [
      cluster("/clients", 2),
      cluster("/clients/:id", 1),
      cluster("/sessions", 1),
    ];
    const expected = JSON.stringify(inferEndpointRoles(rows, clusters));
    const permutations = [
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ];
    for (const order of permutations) {
      const shuffledRows = order.map((index) => rows[index]);
      const shuffledClusters = [...clusters].reverse();
      expect(
        JSON.stringify(inferEndpointRoles(shuffledRows, shuffledClusters)),
      ).toBe(expected);
    }
  });

  it("sorts candidates and refusals canonically", () => {
    // Slot templates are value-free, so canonical order is by structure alone.
    const paths = ["/a/b/c", "/a", "/a/b/c/d", "/a/b"];
    const rows = paths.flatMap((prefix, index) =>
      [101, 102].map((id) =>
        observation(`${prefix}/${id}`, index < 2 ? { data: [item(id)] } : id),
      ),
    );
    const result = inferEndpointRoles(
      rows,
      paths.map((prefix) => cluster(`${prefix}/:id`, 2)),
    );
    expect(result.candidates.map((entry) => entry.endpoint.template)).toEqual([
      "/:s1/:id",
      "/:s1/:s2/:s3/:id",
    ]);
    expect(result.refused.map((entry) => entry.endpoint.template)).toEqual([
      "/:s1/:s2/:id",
      "/:s1/:s2/:s3/:s4/:id",
    ]);
  });

  it("does not mutate its inputs", () => {
    const rows = listBodies("/clients", 2, ["page"]);
    const clusters = [cluster("/clients", 2)];
    const rowsBefore = JSON.stringify(rows),
      clustersBefore = JSON.stringify(clusters);
    inferEndpointRoles(rows, clusters);
    expect(JSON.stringify(rows)).toBe(rowsBefore);
    expect(JSON.stringify(clusters)).toBe(clustersBefore);
  });
});

describe("inferEndpointRoles — privacy", () => {
  it("never serializes response values, ids, query values, headers, or times", () => {
    const rows = [
      observation(
        "/clients/101",
        {
          data: {
            items: [
              {
                id: "a3f9c2d1",
                email: "person@mail.invalid",
                phone: "555-0142",
                balance: 1234.5,
              },
            ],
          },
        },
        {
          queryKeys: ["page", "limit"],
          capturedAt: "2026-09-10T12:00:00.000Z",
          headers: { authorization: "[REDACTED]" },
        },
      ),
    ];
    const serialized = JSON.stringify(
      inferEndpointRoles(rows, [
        cluster("/clients/:id/reports", 0),
        cluster("/clients/:id", 1),
      ]),
    );
    for (const leak of [
      "a3f9c2d1",
      "person@mail.invalid",
      "555-0142",
      "1234.5",
      "authorization",
      "REDACTED",
      "2026-09-10",
      "101",
    ])
      expect(serialized).not.toContain(leak);
    expect(serialized).toContain("object{number*1,string*3}");
  });

  it.each([["__proto__"], ["constructor"], ["access_token"], ["session"]])(
    "never emits the forbidden container key %s",
    (key) => {
      const rows = [
        observation(
          "/clients",
          Object.assign(Object.create(null), { [key]: [item(1)] }),
        ),
      ];
      const result = inferEndpointRoles(rows, [cluster("/clients", 1)]);
      expect(JSON.stringify(result)).not.toContain(key);
      expect(result.candidates).toEqual([]);
      expect(result.refused[0].reason).toBe("unsafe_path_key");
    },
  );

  it.each([["a b"], ["9leading"]])(
    "reads the data-like container key %s as a dynamic key, never raw",
    (key) => {
      const rows = [observation("/clients", { [key]: [item(1)] })];
      const result = inferEndpointRoles(rows, [cluster("/clients", 1)]);
      expect(JSON.stringify(result)).not.toContain(key);
      expect(only(result).itemsPath).toEqual([DYN]);
      expect(only(result).reasons).toContain(DYNAMIC_KEY_REASON);
    },
  );

  it("refuses a data-like key outside a recognized map", () => {
    const rows = [
      observation("/clients", { "a b": [item(1)], meta: { total: 1 } }),
    ];
    const result = inferEndpointRoles(rows, [cluster("/clients", 1)]);
    expect(JSON.stringify(result)).not.toContain("a b");
    expect(onlyRefusal(result).reason).toBe("unsafe_path_key");
  });

  it("refuses to echo a contact-like template literal", () => {
    const rows = [observation("/u/5551234567/log", { data: [item(1)] })];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/u/5551234567/log", 1)])),
    ).toEqual({
      endpoint: { origin: ORIGIN, method: "GET", template: null },
      reason: "unsafe_template_literal",
      support: 1,
    });
  });

  it("refuses to echo a double-encoded address-like template literal", () => {
    const rows = [observation("/u/person%2540mail/log", { data: [item(1)] })];
    const refusal = onlyRefusal(
      inferEndpointRoles(rows, [cluster("/u/person%2540mail/log", 1)]),
    );
    expect(refusal.reason).toBe("unsafe_template_literal");
    expect(JSON.stringify(refusal)).not.toContain("person");
  });

  it("emits no platform, vendor, or product literal", () => {
    const rows = [
      ...listBodies("/clients", 2, ["page"]),
      observation("/clients/101", item(1)),
    ];
    const serialized = JSON.stringify(
      inferEndpointRoles(rows, [
        cluster("/clients", 2),
        cluster("/clients/:id", 1),
      ]),
    );
    const tokens = [
      ...new Set(serialized.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []),
    ].sort();
    expect(tokens).toEqual([
      "GET",
      "boolean",
      "candidates",
      "coach",
      "detail",
      "detail_body_not_representable",
      "endpoint",
      "example",
      "false",
      "https",
      "itemShape",
      "itemsPath",
      "k1",
      "k2",
      "key",
      "list",
      "method",
      "null",
      "number",
      "object",
      "origin",
      "page",
      "paginated",
      "paginationEvidence",
      "pagination_descriptor_required",
      "queryKeys",
      "reasons",
      "refused",
      "replayCompatible",
      "roles",
      "session_key_rebinding_required",
      "slot",
      "string",
      "styles",
      "support",
      "template",
      "type",
      "unproven_template_literal",
      "windowEvidence",
    ]);
  });
});

describe("inferEndpointRoles — C2a pipeline and replay seam", () => {
  const snapshot = [
    ...Array.from({ length: 3 }, (_unused, index) => ({
      url: `${ORIGIN}/api/clients?page=${index + 1}`,
      method: "GET",
      statusCode: 200,
      responseBody: JSON.stringify({ data: [item(index)] }),
    })),
    ...[101, 102, 103].map((id) => ({
      url: `${ORIGIN}/api/clients/${id}`,
      method: "GET",
      statusCode: 200,
      responseBody: JSON.stringify(item(id)),
    })),
  ];

  function pipeline() {
    const { observations } = normalizeCaptureSnapshot(snapshot);
    const { clusters } = inferUrlTemplates(observations);
    return { observations, result: inferEndpointRoles(observations, clusters) };
  }

  it("joins real normalized observations to real inferred clusters", () => {
    const { result } = pipeline();
    expect(result.refused).toEqual([]);
    expect(
      result.candidates.map((entry) => [
        entry.endpoint.template,
        entry.roles.join("+"),
      ]),
    ).toEqual([
      ["/:s1/:s2/:id", "detail"],
      [null, "list+paginated"],
    ]);
  });

  it("feeds a slot-free proven list candidate into a blueprint normalizeBlueprint accepts", () => {
    // Positive control: a template with no literal is fully proven structure,
    // so it stays emitted and replay-compatible.
    // A root array has an empty items path: no key to rebind.
    const rows = [101, 202].map((id) =>
      observation(`/${id}`, [item(1), item(2)]),
    );
    const candidate = only(inferEndpointRoles(rows, [cluster("/:id", 2)]));
    expect(candidate.endpoint.template).toBe("/:id");
    expect(candidate.replayCompatible).toBe(true);
    expect(candidate.reasons).toEqual([]);
    // Step "clients" is hand-written: proving a lone list endpoint is C2b-2.
    const blueprint = normalizeBlueprint(
      {
        platform: "inferred",
        apiBase: candidate.endpoint.origin,
        steps: [
          {
            id: "clients",
            entityType: "client",
            template: "/api/clients",
            itemsPath: ["data"],
            collectAs: "clientIds",
          },
          {
            id: "list",
            entityType: "record",
            method: candidate.endpoint.method,
            template: candidate.endpoint.template,
            itemsPath: candidate.itemsPath,
            forEach: "clientIds",
          },
        ],
      },
      { allowedOrigins: [candidate.endpoint.origin] },
    );
    expect(blueprint.steps[1].template).toBe("/:id");
    expect(blueprint.steps[1].itemsPath).toEqual([]);
    expect(blueprint.steps[1].pagination).toBeNull();
    expect(
      extractItems(rows[0].body, blueprint.steps[1].itemsPath),
    ).toHaveLength(2);
  });

  it("keeps a slot template out of replay until its slots are rebound", () => {
    const rows = [101, 202].map((id) =>
      observation(`/api/clients/${id}/workouts`, { data: [item(1)] }),
    );
    const candidate = only(
      inferEndpointRoles(rows, [cluster("/api/clients/:id/workouts", 2)]),
    );
    expect(candidate.endpoint.template).toBe("/:s1/:s2/:id/:s3");
    expect(candidate.replayCompatible).toBe(false);
    expect(candidate.reasons).toEqual([KEY_SLOT_REASON, SESSION_SLOT_REASON]);
  });

  it("keeps a slot-free template with a keyed items path out of replay", () => {
    const rows = [101, 202].map((id) =>
      observation(`/${id}`, { data: [item(1)] }),
    );
    const candidate = only(inferEndpointRoles(rows, [cluster("/:id", 2)]));
    expect(candidate.endpoint.template).toBe("/:id");
    expect(candidate.itemsPath).toEqual([K(1)]);
    expect(candidate.replayCompatible).toBe(false);
    expect(candidate.reasons).toEqual([KEY_SLOT_REASON]);
  });

  it("keeps detail, window, and pagination candidates explicitly non-runnable", () => {
    const cases = [
      [observation("/clients/101", item(1)), cluster("/clients/:id", 1)],
      [
        observation(
          "/sessions",
          { data: [item(1)] },
          {
            queryKeys: ["from", "to"],
          },
        ),
        cluster("/sessions", 1),
      ],
      [
        observation("/clients", { data: [item(1)] }, { queryKeys: ["cursor"] }),
        cluster("/clients", 1),
      ],
    ];
    for (const [row, template] of cases) {
      const candidate = only(inferEndpointRoles([row], [template]));
      expect(candidate.replayCompatible).toBe(false);
      expect(candidate.reasons.length).toBeGreaterThan(0);
      expect(candidate).not.toHaveProperty("confidence");
      expect(candidate).not.toHaveProperty("pagination");
      expect(candidate).not.toHaveProperty("idField");
    }
  });

  it("never emits a confidence score or a runnable descriptor", () => {
    const { result } = pipeline();
    const serialized = JSON.stringify(result);
    for (const forbidden of ["confidence", "score", "nextPath", "idField"])
      expect(serialized).not.toContain(forbidden);
  });
});

describe("inferEndpointRoles — review closures (B1–B3)", () => {
  function normalized(entries, templateOptions) {
    const { observations } = normalizeCaptureSnapshot(
      entries.map(([path, body]) => ({
        url: `${ORIGIN}${path}`,
        method: "GET",
        statusCode: 200,
        responseBody: JSON.stringify(body),
      })),
    );
    const { clusters } = inferUrlTemplates(observations, templateOptions);
    return inferEndpointRoles(observations, clusters);
  }
  const workouts = { items: [{ id: 5 }] };

  it.each([
    ["/clients/alice/workouts", ["alice"]],
    ["/clients/jane-doe/workouts", ["jane", "doe"]],
    ["/clients/101/workouts", ["101"]],
  ])(
    "B1: keeps a one-off normalized list GET %s unproven, non-replayable and literal-free",
    (path, leaks) => {
      const result = normalized([[path, workouts]]);
      const candidate = only(result);
      expect(candidate.endpoint).toEqual({
        origin: ORIGIN,
        method: "GET",
        template: null,
      });
      expect(candidate.roles).toEqual(["list"]);
      expect(candidate.replayCompatible).toBe(false);
      expect(candidate.reasons).toEqual([
        KEY_SLOT_REASON,
        "unproven_template_literal",
      ]);
      for (const leak of [...leaks, "clients", "workouts", '"items"'])
        expect(JSON.stringify(result)).not.toContain(leak);
    },
  );

  it.each([["/clients"], ["/v2/clients/:id/workouts"]])(
    "B1: withholds %s when only one distinct dynamic value was seen",
    (template) => {
      const path = template.replace(":id", "101");
      const rows = [observation(path, workouts), observation(path, workouts)];
      const candidate = only(inferEndpointRoles(rows, [cluster(template, 2)]));
      expect(candidate.endpoint.template).toBeNull();
      expect(candidate.replayCompatible).toBe(false);
    },
  );

  it("B1: counts decoded values, so an encoded repeat is not variation", () => {
    const rows = [
      observation("/clients/101/workouts", workouts),
      observation("/clients/%31%30%31/workouts", workouts),
    ];
    const candidate = only(
      inferEndpointRoles(rows, [cluster("/clients/:id/workouts", 2)]),
    );
    expect(candidate.endpoint.template).toBeNull();
  });

  it("B1: withholds the template in refusals of an unproven cluster too", () => {
    const refusal = onlyRefusal(
      inferEndpointRoles(
        [observation("/clients/alice/workouts", workouts)],
        [cluster("/clients/alice/workouts", 3)],
      ),
    );
    expect(refusal).toEqual({
      endpoint: { origin: ORIGIN, method: "GET", template: null },
      reason: "template_support_mismatch",
      support: 1,
    });
  });

  it.each([
    ["/:s1/:id/:s2", ""],
    ["/:s1/:s2/:id/:s3", "/v2"],
  ])(
    "B1: proves the dynamic position of %s from two distinct normalized ids",
    (template, prefix) => {
      const rows = [101, 202].map((id) => [
        `${prefix}/clients/${id}/workouts`,
        workouts,
      ]);
      const candidate = only(normalized(rows, { minDistinct: 2 }));
      expect(candidate.endpoint.template).toBe(template);
      expect(candidate.support).toBe(2);
      expect(candidate.replayCompatible).toBe(false);
      expect(candidate.reasons).toEqual([KEY_SLOT_REASON, SESSION_SLOT_REASON]);
      expect(JSON.stringify(candidate)).not.toMatch(
        /clients|workouts|v2|"items"/,
      );
      // At C2a's default distinct threshold the pair stays literal: fail closed.
      const strict = normalized(rows);
      expect(strict.candidates.every((entry) => !entry.replayCompatible)).toBe(
        true,
      );
      expect(JSON.stringify(strict)).not.toMatch(/101|202/);
    },
  );

  it("B2: refuses a credential-bearing origin without echoing it", () => {
    const origin = "https://person:password@coach.example";
    const result = inferEndpointRoles(
      [observation("/clients", { data: [item(1)] }, { origin })],
      [cluster("/clients", 1, { origin })],
    );
    expect(result).toEqual({
      candidates: [],
      refused: [{ endpoint: null, reason: "invalid_origin", support: 2 }],
    });
    for (const leak of ["person", "password", "@"])
      expect(JSON.stringify(result)).not.toContain(leak);
  });

  it.each([
    ["http://coach.example"],
    ["https://coach.example/"],
    ["https://coach.example/api"],
    ["https://coach.example?x=1"],
    ["https://coach.example#frag"],
    ["https://user@coach.example"],
    ["not a url"],
  ])("B2: refuses the non-origin %s", (origin) => {
    const result = inferEndpointRoles(
      [observation("/clients", { data: [item(1)] }, { origin })],
      [cluster("/clients", 1, { origin })],
    );
    expect(result.candidates).toEqual([]);
    expect(result.refused).toEqual([
      { endpoint: null, reason: "invalid_origin", support: 2 },
    ]);
  });

  it("B3: refuses a normalized 201-key item instead of a list", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 201 }, (_unused, index) => [`key${index}`, index]),
    );
    const refusal = onlyRefusal(normalized([["/clients", { items: [wide] }]]));
    expect(refusal.reason).toBe("uninspected_item_shape");
  });

  it("B3: refuses an item that exhausts the shape-work limit", () => {
    const heavy = Object.fromEntries(
      Array.from({ length: 60 }, (_unused, index) => [
        `key${index}`,
        Array.from({ length: 100 }, (_value, slot) => slot),
      ]),
    );
    const refusal = onlyRefusal(normalized([["/clients", { items: [heavy] }]]));
    expect(refusal.reason).toBe("uninspected_item_shape");
  });

  it("B3: refuses an uninspectable detail body and a cyclic item", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 201 }, (_unused, index) => [`key${index}`, index]),
    );
    const cyclic = { id: 1 };
    cyclic.self = cyclic;
    for (const [row, template] of [
      [observation("/clients/101", wide), cluster("/clients/:id", 1)],
      [observation("/clients", { data: [cyclic] }), cluster("/clients", 1)],
    ])
      expect(onlyRefusal(inferEndpointRoles([row], [template])).reason).toBe(
        "uninspected_item_shape",
      );
  });
});

describe("inferEndpointRoles — review closure C2B1-SOL-A1 (fixed literals)", () => {
  function snapshotOf(paths) {
    return paths.map((path) => ({
      url: `${ORIGIN}${path}`,
      method: "GET",
      statusCode: 200,
      responseBody: JSON.stringify({ items: [{ id: 5 }] }),
    }));
  }
  function run(snapshot) {
    const { observations } = normalizeCaptureSnapshot(snapshot);
    const { clusters } = inferUrlTemplates(observations);
    return inferEndpointRoles(observations, clusters);
  }
  const parent = (slug) =>
    [101, 202, 303].map((id) => `/coaches/${slug}/clients/${id}/workouts`);

  it.each([
    ["alice", ["alice"]],
    ["jane-doe", ["jane", "doe"]],
    ["private-tenant", ["private", "tenant"]],
  ])(
    "A1: never emits or replays the fixed parent slug %s beside a varied :id",
    (slug, leaks) => {
      const result = run(snapshotOf(parent(slug)));
      expect(result).toEqual({
        candidates: [
          {
            endpoint: {
              origin: ORIGIN,
              method: "GET",
              template: "/:s1/:s2/:s3/:id/:s4",
            },
            roles: ["list"],
            itemsPath: [K(1)],
            itemShape: "object{number*1}",
            support: 3,
            windowEvidence: null,
            paginationEvidence: null,
            replayCompatible: false,
            reasons: [KEY_SLOT_REASON, SESSION_SLOT_REASON],
          },
        ],
        refused: [],
      });
      const serialized = JSON.stringify(result);
      for (const leak of [
        ...leaks,
        "coaches",
        "clients",
        "workouts",
        '"items"',
      ])
        expect(serialized).not.toContain(leak);
      expect(serialized).not.toMatch(/101|202|303/);
    },
  );

  it("A1 positive control: a structural route keeps its role evidence and gives the same value-free output", () => {
    const structural = run(
      snapshotOf([101, 202, 303].map((id) => `/api/v2/clients/${id}/workouts`)),
    );
    const candidate = only(structural);
    expect(candidate.roles).toEqual(["list"]);
    expect(candidate.itemsPath).toEqual([K(1)]);
    expect(candidate.support).toBe(3);
    // Output is a function of structure only: a coach slug and a structural
    // name in the same position are indistinguishable, so neither is emitted.
    expect(JSON.stringify(structural)).toBe(
      JSON.stringify(run(snapshotOf(parent("alice")))),
    );
  });

  it("A1 positive control: a slot-free proven template stays emitted and replay-compatible", () => {
    const candidate = only(
      run(
        ["/101", "/202", "/303"].map((path) => ({
          url: `${ORIGIN}${path}`,
          method: "GET",
          statusCode: 200,
          responseBody: JSON.stringify([{ id: 5 }]),
        })),
      ),
    );
    expect(candidate.endpoint.template).toBe("/:id");
    expect(candidate.itemsPath).toEqual([]);
    expect(candidate.replayCompatible).toBe(true);
    expect(candidate.reasons).toEqual([]);
  });

  it("A1: output is byte-identical under every permutation of the capture", () => {
    const rows = [
      ...parent("alice"),
      "/api/clients/7/notes",
      "/api/clients/8/notes",
      "/api/clients/9/notes",
    ];
    const permute = (list) =>
      list.length <= 1
        ? [list]
        : list.flatMap((head, index) =>
            permute([...list.slice(0, index), ...list.slice(index + 1)]).map(
              (tail) => [head, ...tail],
            ),
          );
    const expected = JSON.stringify(run(snapshotOf(rows)));
    const orders = permute([0, 1, 2, 3, 4, 5]);
    expect(orders).toHaveLength(720);
    for (const order of orders)
      expect(JSON.stringify(run(snapshotOf(order.map((i) => rows[i]))))).toBe(
        expected,
      );
    expect(expected).not.toMatch(
      /alice|coaches|clients|notes|workouts|api|"items"/,
    );
  });
});

describe("inferEndpointRoles — review closure C2B1-SOL2-A1 (container keys)", () => {
  const coachPaths = [101, 202, 303].map(
    (id) => `/coaches/alice/clients/${id}/workouts`,
  );
  function run(paths, bodyFor) {
    const { observations } = normalizeCaptureSnapshot(
      paths.map((path, index) => ({
        url: `${ORIGIN}${path}`,
        method: "GET",
        statusCode: 200,
        responseBody: JSON.stringify(bodyFor(index)),
      })),
    );
    const { clusters } = inferUrlTemplates(observations);
    return inferEndpointRoles(observations, clusters);
  }
  // Every string the output may carry comes from a fixed, value-free
  // vocabulary: the accepted origin, a method, slot templates, C2a shape
  // signatures, fixed role/reason/query names, and typed key steps.
  const FIXED = new Set([
    ORIGIN,
    "GET",
    "HEAD",
    "list",
    "detail",
    "windowed",
    "paginated",
    "key",
    "dynamic_key",
    "page",
    "cursor",
  ]);
  function assertValueFree(result) {
    const visit = (node, parentKey) => {
      if (Array.isArray(node))
        return node.forEach((entry) => visit(entry, parentKey));
      if (node !== null && typeof node === "object")
        return Object.entries(node).forEach(([key, value]) => {
          expect(key).toMatch(/^[a-zA-Z]+$/);
          visit(value, key);
        });
      if (typeof node !== "string") return;
      if (parentKey === "template")
        expect(node).toMatch(/^(?:\/(?::s\d+|:id))*$/);
      else if (parentKey === "slot") expect(node).toMatch(/^k\d+$/);
      else if (parentKey === "itemShape")
        expect(node).toMatch(/^[a-z0-9*{}[\](),|.]+$/);
      else if (parentKey === "reasons" || parentKey === "reason")
        expect(node).toMatch(/^[a-z_]+$/);
      else expect(FIXED.has(node)).toBe(true);
    };
    visit(result, null);
    for (const candidate of result.candidates)
      if (
        candidate.itemsPath?.length > 0 ||
        /:s\d/.test(candidate.endpoint.template ?? ":s")
      )
        expect(candidate.replayCompatible).toBe(false);
  }

  it("A1: the reviewer's name-keyed body never emits the name", () => {
    const result = run(coachPaths, () => ({ alice: [{ id: 5 }] }));
    const candidate = only(result);
    expect(candidate.itemsPath).toEqual([K(1)]);
    expect(candidate.replayCompatible).toBe(false);
    expect(candidate.reasons).toEqual([KEY_SLOT_REASON, SESSION_SLOT_REASON]);
    expect(JSON.stringify(result)).not.toContain("alice");
    assertValueFree(result);
    // Value-free: identical to the same capture keyed by a structural name.
    expect(JSON.stringify(result)).toBe(
      JSON.stringify(run(coachPaths, () => ({ items: [{ id: 5 }] }))),
    );
  });

  const NAME_KEYS = ["alice", "jane_doe", "JaneDoe", "private-tenant"];
  const DATA_KEYS = [
    "jane.doe@mail.invalid",
    "person+tag@mail.invalid",
    "101",
    "3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b",
    "José",
    "Zoë Ångström",
    "名前",
    "jane doe",
  ];
  const leakParts = (key) =>
    key.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length >= 2);
  /** @type {Record<string, (key: string) => object>} */
  const placements = {
    "as the container key": (key) => ({ [key]: [{ id: 5 }] }),
    "nested under a wrapper": (key) => ({ data: { [key]: [{ id: 5 }] } }),
    "nested above a wrapper": (key) => ({
      data: { [key]: { rows: [{ id: 5 }] } },
    }),
  };

  describe.each(Object.keys(placements))("%s", (label) => {
    const body = placements[label];
    it.each(NAME_KEYS)("never emits the name-like key %s raw", (key) => {
      const result = run(coachPaths, () => body(key));
      const candidate = only(result);
      expect(candidate.itemsPath.every((s) => s.type === "key")).toBe(true);
      for (const part of leakParts(key))
        expect(JSON.stringify(result)).not.toContain(part);
      assertValueFree(result);
      expect(JSON.stringify(result)).toBe(
        JSON.stringify(run(coachPaths, () => body("items"))),
      );
    });

    it.each(DATA_KEYS)("reads the data-like key %s as a dynamic key", (key) => {
      const result = run(coachPaths, () => body(key));
      const candidate = only(result);
      expect(candidate.itemsPath).toContainEqual(DYN);
      expect(candidate.reasons).toContain(DYNAMIC_KEY_REASON);
      const serialized = JSON.stringify(result);
      for (const part of leakParts(key)) expect(serialized).not.toContain(part);
      assertValueFree(result);
      // Output depends on the key's class only, never on its value.
      expect(serialized).toBe(
        JSON.stringify(run(coachPaths, () => body("other@mail.invalid"))),
      );
    });
  });

  it.each([
    [
      "id-keyed records",
      { clients: { 101: item(1), 202: item(2), 303: item(3) } },
      [K(1), DYN],
    ],
    [
      "email-keyed arrays",
      { "a@mail.invalid": [item(1)], "b@mail.invalid": [item(2)] },
      [DYN],
    ],
    [
      "three homogeneous name-keyed arrays",
      { alice: [item(1)], bob: [item(2)], carol: [item(3)] },
      [DYN],
    ],
    [
      "uuid-keyed records under two wrappers",
      {
        data: {
          groups: {
            "3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b": item(1),
            "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f": item(2),
          },
        },
      },
      [K(1), K(2), DYN],
    ],
  ])("represents a map of %s as a dynamic-key marker", (_label, body, path) => {
    const result = run(coachPaths, () => body);
    const candidate = only(result);
    expect(candidate.roles).toEqual(["list"]);
    expect(candidate.itemsPath).toEqual(path);
    expect(candidate.itemShape).toBe("object{boolean*1,number*1,string*1}");
    expect(candidate.replayCompatible).toBe(false);
    expect(candidate.reasons).toContain(DYNAMIC_KEY_REASON);
    expect(JSON.stringify(result)).not.toMatch(
      /alice|bob|carol|@|mail|101|202|303|3f2b|9c1d|groups|clients|"data"/,
    );
    assertValueFree(result);
  });

  it("gives a map the same output under any key order and any key values", () => {
    const bodies = [
      { 101: item(1), 202: item(2), 303: item(3) },
      { 303: item(3), 101: item(1), 202: item(2) },
      { 7: item(9), 8: item(8), 9: item(7) },
    ];
    const outputs = bodies.map((body) =>
      JSON.stringify(run(coachPaths, () => body)),
    );
    expect(new Set(outputs).size).toBe(1);
  });

  it("refuses two name-keyed arrays rather than guessing, without echoing", () => {
    const result = run(coachPaths, () => ({
      alice: [item(1)],
      bob: [item(2)],
    }));
    expect(onlyRefusal(result).reason).toBe("ambiguous_items_path");
    expect(JSON.stringify(result)).not.toMatch(/alice|bob/);
    assertValueFree(result);
  });

  it.each([
    ["an id-keyed object with unequal values", { 101: item(1), 202: [1] }],
    ["an email key beside metadata", { "a@mail.invalid": [item(1)], n: 1 }],
  ])("refuses %s without echoing any key", (_label, body) => {
    const result = run(coachPaths, () => body);
    expect(onlyRefusal(result).reason).toBe("unsafe_path_key");
    expect(JSON.stringify(result)).not.toMatch(/101|202|@|mail|token/);
    assertValueFree(result);
  });

  it("refuses a credential key inside a map-shaped object, even un-normalized", () => {
    // C2a strips credential keys first; C2b refuses on its own as well.
    const rows = [101, 202].map((id) =>
      observation(`/coaches/alice/clients/${id}/workouts`, {
        101: [item(1)],
        202: [item(2)],
        token: [item(3)],
      }),
    );
    const result = inferEndpointRoles(rows, [
      cluster("/coaches/alice/clients/:id/workouts", 2),
    ]);
    expect(onlyRefusal(result).reason).toBe("unsafe_path_key");
    expect(JSON.stringify(result)).not.toMatch(/101|202|token|alice/);
  });

  it("is byte-identical under every permutation of a capture with keyed and map bodies", () => {
    const rows = [
      ...coachPaths.map((path) => [path, { alice: [{ id: 5 }] }]),
      ...[7, 8, 9].map((id) => [
        `/api/clients/${id}/notes`,
        { "x@mail.invalid": { id: 1 }, "y@mail.invalid": { id: 2 } },
      ]),
    ];
    const permute = (list) =>
      list.length <= 1
        ? [list]
        : list.flatMap((head, index) =>
            permute([...list.slice(0, index), ...list.slice(index + 1)]).map(
              (tail) => [head, ...tail],
            ),
          );
    const runRows = (ordered) =>
      JSON.stringify(
        run(
          ordered.map(([path]) => path),
          (index) => ordered[index][1],
        ),
      );
    const expected = runRows(rows);
    const orders = permute([0, 1, 2, 3, 4, 5]);
    expect(orders).toHaveLength(720);
    for (const order of orders)
      expect(runRows(order.map((i) => rows[i]))).toBe(expected);
    expect(expected).not.toMatch(/alice|@|mail|coaches|notes|api/);
    assertValueFree(JSON.parse(expected));
  });
});

describe("inferEndpointRoles — X3 seam C2B1-SOL2-X3-1 (slot-template collisions)", () => {
  function run(paths) {
    const { observations } = normalizeCaptureSnapshot(
      paths.map((path) => ({
        url: `${ORIGIN}${path}`,
        method: "GET",
        statusCode: 200,
        responseBody: JSON.stringify([{ id: 5 }]),
      })),
    );
    const { clusters } = inferUrlTemplates(observations);
    return inferEndpointRoles(observations, clusters);
  }
  const alice = [101, 202, 303].map(
      (id) => `/coaches/alice/clients/${id}/workouts`,
    ),
    bob = [101, 202, 303].map((id) => `/groups/bob/members/${id}/workouts`);

  it("flags, never merges, two routes that collapse to one slot template", () => {
    const result = run([...alice, ...bob]);
    expect(result.refused).toEqual([]);
    expect(result.candidates).toHaveLength(2);
    for (const candidate of result.candidates) {
      expect(candidate.endpoint.template).toBe("/:s1/:s2/:s3/:id/:s4");
      expect(candidate.support).toBe(3);
      expect(candidate.replayCompatible).toBe(false);
      expect(candidate.reasons).toEqual(
        [SESSION_SLOT_REASON, COLLISION_REASON].sort(),
      );
    }
    expect(JSON.stringify(result)).not.toMatch(
      /alice|bob|coaches|groups|members|workouts/,
    );
  });

  it("does not flag a lone route or routes of different arity", () => {
    for (const paths of [
      alice,
      [...alice, ...[7, 8, 9].map((id) => `/api/clients/${id}/notes`)],
    ]) {
      const result = run(paths);
      for (const candidate of result.candidates)
        expect(candidate.reasons).not.toContain(COLLISION_REASON);
    }
  });

  it("flags a candidate whose colliding partner was refused", () => {
    const rows = [
      ...alice.map((path) => observation(path, [item(1)])),
      ...bob.map((path) => observation(path, [item(1)])),
    ];
    const result = inferEndpointRoles(rows, [
      cluster("/coaches/alice/clients/:id/workouts", 3),
      cluster("/groups/bob/members/:id/workouts", 9),
    ]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].reason).toBe("template_support_mismatch");
    expect(result.refused[0].endpoint.template).toBe("/:s1/:s2/:s3/:id/:s4");
    expect(only({ ...result, refused: [] }).reasons).toContain(
      COLLISION_REASON,
    );
  });

  it("keeps collision output byte-identical under every capture order", () => {
    const rows = [alice[0], alice[1], alice[2], bob[0], bob[1], bob[2]];
    const permute = (list) =>
      list.length <= 1
        ? [list]
        : list.flatMap((head, index) =>
            permute([...list.slice(0, index), ...list.slice(index + 1)]).map(
              (tail) => [head, ...tail],
            ),
          );
    const expected = JSON.stringify(run(rows));
    for (const order of permute([0, 1, 2, 3, 4, 5]))
      expect(JSON.stringify(run(order.map((i) => rows[i])))).toBe(expected);
  });
});
