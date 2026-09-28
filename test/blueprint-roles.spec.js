import { describe, expect, it } from "vitest";
import { normalizeCaptureSnapshot } from "../shared/blueprint/input.js";
import {
  inferEndpointRoles,
  ROLE_HARD_LIMITS,
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
    expect(candidate).toEqual({
      endpoint: { origin: ORIGIN, method: "GET", template: "/clients" },
      roles: ["list"],
      itemsPath: [],
      itemShape: "object{boolean*1,number*1,string*1}",
      support: 2,
      windowEvidence: null,
      paginationEvidence: null,
      replayCompatible: true,
      reasons: [],
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
    expect(candidate.itemsPath).toEqual(["data", "items"]);
    expect(candidate.replayCompatible).toBe(true);
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
    expect(candidate.reasons).toEqual(["detail_body_not_representable"]);
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
    expect(candidate.itemsPath).toEqual(["items"]);
    expect(candidate.replayCompatible).toBe(true);
  });

  it("refuses a static singleton object as metadata rather than a detail", () => {
    const rows = [observation("/settings", { locale: "en", theme: "dark" })];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/settings", 1)])),
    ).toEqual({
      endpoint: { origin: ORIGIN, method: "GET", template: "/settings" },
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
    expect(candidate.reasons).toEqual(["window_not_representable"]);
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
    expect(candidate.reasons).toEqual(["pagination_descriptor_required"]);
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
      expect(candidate.replayCompatible).toBe(true);
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
      expect(candidate.reasons).toEqual(["ambiguous_cursor_keys"]);
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
    expect(candidate.replayCompatible).toBe(true);
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
    expect(candidate.itemsPath).toEqual(["data"]);
    expect(candidate.support).toBe(2);
  });
});

describe("inferEndpointRoles — template join", () => {
  it("prefers an exact literal template over an overlapping dynamic one", () => {
    const rows = [observation("/clients/archived", { data: [item(1)] })];
    const result = inferEndpointRoles(rows, [
      cluster("/clients/archived", 1),
      cluster("/clients/:id", 0),
    ]);
    expect(result.candidates.map((entry) => entry.endpoint.template)).toEqual([
      "/clients/archived",
    ]);
    expect(result.refused).toEqual([
      {
        endpoint: { origin: ORIGIN, method: "GET", template: "/clients/:id" },
        reason: "no_successful_get_evidence",
        support: 0,
      },
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
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/clients", 0)])),
    ).toEqual({
      endpoint: { origin: ORIGIN, method: "GET", template: null },
      reason: "unmatched_observation",
      support: 1,
    });
  });

  it("refuses a cluster whose declared support disagrees with the join", () => {
    const rows = [observation("/clients", { data: [item(1)] })];
    expect(
      onlyRefusal(inferEndpointRoles(rows, [cluster("/clients", 4)])),
    ).toEqual({
      endpoint: { origin: ORIGIN, method: "GET", template: "/clients" },
      reason: "template_support_mismatch",
      support: 1,
    });
  });

  it("refuses a template with more than one dynamic segment", () => {
    const rows = [
      observation("/clients/101/workouts/2001", { data: [item(1)] }),
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
      "no_successful_get_evidence",
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
    expect(candidate.itemsPath).toEqual(["data"]);
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
      if (depth <= 2) expect(only(result).itemsPath).toEqual(keys);
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
    if (accepted) expect(only(result).itemsPath).toEqual(["k0"]);
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
    const rows = [
      observation("/zeta", { data: [item(1)] }),
      observation("/alpha", { data: [item(2)] }),
      observation("/omega", 5),
      observation("/beta", 6),
    ];
    const result = inferEndpointRoles(rows, [
      cluster("/zeta", 1),
      cluster("/alpha", 1),
      cluster("/omega", 1),
      cluster("/beta", 1),
    ]);
    expect(result.candidates.map((entry) => entry.endpoint.template)).toEqual([
      "/alpha",
      "/zeta",
    ]);
    expect(result.refused.map((entry) => entry.endpoint.template)).toEqual([
      "/beta",
      "/omega",
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

  it.each([
    ["__proto__"],
    ["constructor"],
    ["access_token"],
    ["session"],
    ["a b"],
    ["9leading"],
  ])("never emits the unsafe container key %s", (key) => {
    const rows = [
      observation(
        "/clients",
        Object.assign(Object.create(null), { [key]: [item(1)] }),
      ),
    ];
    const result = inferEndpointRoles(rows, [cluster("/clients", 1)]);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result.candidates).toEqual([]);
    expect(result.refused[0].reason).toBe("metadata_only");
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
      "data",
      "detail",
      "detail_body_not_representable",
      "endpoint",
      "example",
      "false",
      "https",
      "id",
      "itemShape",
      "itemsPath",
      "list",
      "method",
      "number",
      "object",
      "origin",
      "paginated",
      "pagination_descriptor_required",
      "paginationEvidence",
      "page",
      "queryKeys",
      "reasons",
      "refused",
      "replayCompatible",
      "roles",
      "string",
      "styles",
      "support",
      "template",
      "true",
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
      ["/api/clients", "list+paginated"],
      ["/api/clients/:id", "detail"],
    ]);
  });

  it("feeds a plain-list candidate into a blueprint normalizeBlueprint accepts", () => {
    const rows = [observation("/api/clients", { data: [item(1), item(2)] })];
    const candidate = only(
      inferEndpointRoles(rows, [cluster("/api/clients", 1)]),
    );
    expect(candidate.replayCompatible).toBe(true);
    const blueprint = normalizeBlueprint(
      {
        platform: "inferred",
        apiBase: candidate.endpoint.origin,
        steps: [
          {
            id: "list",
            entityType: "record",
            method: candidate.endpoint.method,
            template: candidate.endpoint.template,
            itemsPath: candidate.itemsPath,
          },
        ],
      },
      { allowedOrigins: [candidate.endpoint.origin] },
    );
    expect(blueprint.steps[0].template).toBe("/api/clients");
    expect(blueprint.steps[0].itemsPath).toEqual(["data"]);
    expect(blueprint.steps[0].pagination).toBeNull();
    expect(
      extractItems(rows[0].body, blueprint.steps[0].itemsPath),
    ).toHaveLength(2);
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
