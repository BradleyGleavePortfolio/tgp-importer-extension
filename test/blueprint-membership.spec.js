import { describe, expect, it } from "vitest";
import { normalizeCaptureSnapshot } from "../shared/blueprint/input.js";
import {
  MEMBERSHIP_REASON_CODES,
  selectClusterObservations,
  validateObservationMembership,
} from "../shared/blueprint/membership.js";
import { inferUrlTemplates } from "../shared/blueprint/url-templates.js";

const ORIGIN = "https://coach.example";
const OTHER = "https://other.example";

function observation(path, overrides = {}) {
  return {
    origin: ORIGIN,
    path,
    queryKeys: [],
    method: "GET",
    ...overrides,
  };
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function derive(observations, options) {
  const result = inferUrlTemplates(observations, {
    ...options,
    membership: true,
  });
  return { result, membership: clone(result.membership) };
}
function reasonsFor(observations, mutate, options) {
  const { membership } = derive(observations, options);
  mutate(membership);
  return validateObservationMembership(observations, membership, options)
    .reasons;
}

const CLIENTS = [101, 102, 103].map((id) => observation(`/clients/${id}`));
const MIXED = [
  ...CLIENTS,
  observation("/workouts/201"),
  observation("/workouts/202"),
  observation("/workouts/203"),
];

describe("membership provenance emission", () => {
  it("attributes every accepted observation to exactly one cluster", () => {
    const { result, membership } = derive(MIXED);
    expect(membership.observationCount).toBe(MIXED.length);
    expect(membership.clusters.map((entry) => entry.pathPattern)).toEqual(
      result.clusters.map((cluster) => cluster.pathPattern),
    );
    const refs = membership.clusters.flatMap((entry) => entry.refs);
    expect([...refs].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(refs).size).toBe(refs.length);
    for (const [index, entry] of membership.clusters.entries())
      expect(entry.refs.length).toBe(result.clusters[index].observations);
  });

  it("keeps membership opt-in so existing callers see an unchanged result", () => {
    const plain = inferUrlTemplates(MIXED);
    expect(Object.hasOwn(plain, "membership")).toBe(false);
    expect(plain).toEqual({
      clusters: derive(MIXED).result.clusters,
      excluded: [],
    });
  });

  it("preserves duplicate multiplicity as distinct references", () => {
    const rows = [...CLIENTS, observation("/clients/101")];
    const { membership } = derive(rows);
    expect(membership.clusters).toHaveLength(1);
    expect(membership.clusters[0].refs).toEqual([0, 1, 2, 3]);
  });

  it("emits ascending references and a sanitized reason for excluded rows", () => {
    const rows = [
      observation("/clients/101"),
      observation("/clients/102", { method: "POST" }),
      observation("/clients/103"),
      observation("/clients/104", { origin: "http://coach.example" }),
      observation("/clients/105"),
    ];
    const { membership } = derive(rows);
    expect(membership.excluded).toEqual([
      { ref: 1, reason: "invalid_observation" },
      { ref: 3, reason: "invalid_observation" },
    ]);
    expect(membership.clusters[0].refs).toEqual([0, 2, 4]);
  });

  it("reports capped observations as references rather than dropping them silently", () => {
    const { membership } = derive(MIXED, { maxObservations: 4 });
    const capped = membership.excluded.filter(
      ({ reason }) => reason === "observation_limit",
    );
    expect(capped).toHaveLength(2);
    expect(capped.map(({ ref }) => ref)).toEqual(
      [...capped.map(({ ref }) => ref)].sort((a, b) => a - b),
    );
    const kept = membership.clusters.flatMap((entry) => entry.refs);
    expect(kept).toHaveLength(4);
    expect(kept.some((ref) => capped.some((entry) => entry.ref === ref))).toBe(
      false,
    );
  });

  it("contains no raw path, query or header values", () => {
    const rows = [
      observation("/clients/abc123", {
        queryKeys: ["page", "secret_token"],
      }),
      observation("/clients/def456"),
      observation("/clients/ghi789"),
    ];
    const serialized = JSON.stringify(derive(rows).membership);
    for (const value of ["abc123", "def456", "ghi789", "secret_token"])
      expect(serialized).not.toContain(value);
  });

  it("is capture-order invariant when starting from a normalized snapshot", () => {
    const entries = [
      { url: `${ORIGIN}/clients/101`, method: "GET", status: 200 },
      { url: `${ORIGIN}/clients/102?page=2`, method: "GET", status: 200 },
      { url: `${ORIGIN}/clients/103`, method: "GET", status: 200 },
      { url: `${ORIGIN}/workouts/9`, method: "GET", status: 200 },
    ];
    const forward = normalizeCaptureSnapshot(entries).observations;
    const reversed = normalizeCaptureSnapshot(
      [...entries].reverse(),
    ).observations;
    expect(derive(reversed).membership).toEqual(derive(forward).membership);
  });

  it("keeps provenance through dynamic grouping partitions", () => {
    const rows = [
      ...[1, 2, 3].map((id) => observation(`/coaches/${id}/clients`)),
      ...[4, 5, 6].map((id) => observation(`/coaches/${id}/workouts`)),
    ];
    const { result, membership } = derive(rows);
    expect(result.clusters).toHaveLength(2);
    const byPattern = new Map(
      membership.clusters.map((entry) => [entry.pathPattern, entry.refs]),
    );
    expect(byPattern.get("/coaches/:id/clients")).toEqual([0, 1, 2]);
    expect(byPattern.get("/coaches/:id/workouts")).toEqual([3, 4, 5]);
  });
});

describe("validateObservationMembership", () => {
  it("accepts authoritative membership and returns a sealed copy", () => {
    const { membership } = derive(MIXED);
    const outcome = validateObservationMembership(MIXED, membership);
    expect(outcome.valid).toBe(true);
    expect(outcome.reasons).toEqual([]);
    expect(outcome.checked).toEqual({ clusters: 2, references: 6 });
    expect(outcome.membership).toEqual(membership);
    expect(outcome.membership).not.toBe(membership);
    expect(Object.isFrozen(outcome.membership)).toBe(true);
    expect(Object.isFrozen(outcome.membership.clusters[0].refs)).toBe(true);
  });

  it("returns no capability for rejected membership", () => {
    const { membership } = derive(MIXED);
    membership.clusters[0].refs.push(5);
    expect(
      validateObservationMembership(MIXED, membership).membership,
    ).toBeNull();
  });

  it("ignores unknown extra fields without trusting them", () => {
    const { membership } = derive(MIXED);
    membership.extra = "x";
    membership.clusters[0].note = "y";
    const outcome = validateObservationMembership(MIXED, membership);
    expect(outcome.valid).toBe(true);
    expect(Object.keys(outcome.membership)).toEqual([
      "observationCount",
      "clusters",
      "excluded",
    ]);
    expect(Object.keys(outcome.membership.clusters[0])).toEqual([
      "origin",
      "method",
      "pathPattern",
      "refs",
    ]);
  });

  it.each([
    [
      "sparse cluster list",
      (membership) => membership.clusters.push(undefined),
    ],
    [
      "a hole in the cluster list",
      (membership) => {
        membership.clusters.length = membership.clusters.length + 2;
      },
    ],
    [
      "a hole in the exclusion list",
      (membership) => {
        membership.excluded.length = 3;
      },
    ],
    [
      "an oversized pathPattern",
      (membership) => {
        membership.clusters[0].pathPattern = "/" + "x".repeat(5000);
      },
    ],
    [
      "an oversized origin",
      (membership) => {
        membership.clusters[0].origin = "https://" + "x".repeat(3000);
      },
    ],
    [
      "an oversized reason",
      (membership) => {
        membership.excluded = [{ ref: 0, reason: "x".repeat(65) }];
      },
    ],
    [
      "an oversized reference list",
      (membership) => {
        membership.clusters[0].refs = Array.from(
          { length: 1001 },
          (_value, index) => index,
        );
      },
    ],
  ])("fails closed on %s", (_label, mutate) => {
    expect(reasonsFor(MIXED, mutate)).toEqual(["malformed_membership"]);
  });

  it("rejects an oversized reference list without visiting its entries", () => {
    const { membership } = derive(MIXED);
    const refs = new Array(5_000_000);
    for (const index of [0, 1, 4_999_999])
      Object.defineProperty(refs, index, {
        get: () => {
          throw new Error("oversized reference list was traversed");
        },
        configurable: true,
        enumerable: true,
      });
    membership.clusters[0].refs = refs;
    const outcome = validateObservationMembership(MIXED, membership);
    expect(outcome.valid).toBe(false);
    expect(outcome.reasons).toEqual(["malformed_membership"]);
  });

  it("stops at the aggregate reference budget before materializing later clusters", () => {
    const { membership } = derive(MIXED);
    const template = clone(membership.clusters[0]);
    membership.clusters = Array.from({ length: 1000 }, (_value, index) => {
      const entry = clone(template);
      entry.pathPattern = `/bulk-${index}/:id`;
      entry.refs = Array.from({ length: 1000 }, (_ignored, ref) => ref % 6);
      if (index >= 5)
        Object.defineProperty(entry, "refs", {
          get: () => {
            throw new Error("cluster beyond the budget was materialized");
          },
          enumerable: true,
        });
      return entry;
    });
    const outcome = validateObservationMembership(MIXED, membership);
    expect(outcome.valid).toBe(false);
    expect(outcome.reasons).toEqual(["reference_budget"]);
  });

  it("reads each claimed field exactly once and seals what it checked", () => {
    const { membership } = derive(MIXED);
    const truthful = [...membership.clusters[0].refs];
    let reads = 0;
    Object.defineProperty(membership.clusters[0], "refs", {
      get: () => ((reads += 1) === 1 ? truthful : [4, 5]),
      enumerable: true,
    });
    const outcome = validateObservationMembership(MIXED, membership);
    expect(reads).toBe(1);
    expect(outcome.valid).toBe(true);
    expect(outcome.membership.clusters[0].refs).toEqual(truthful);
  });

  it("fails closed when a refs accessor supplies forged references", () => {
    const { membership } = derive(MIXED);
    Object.defineProperty(membership.clusters[0], "refs", {
      get: () => [4, 5],
      enumerable: true,
    });
    const outcome = validateObservationMembership(MIXED, membership);
    expect(outcome.valid).toBe(false);
    expect(outcome.membership).toBeNull();
  });

  it("is unaffected by mutation of the caller's arrays after validation", () => {
    const { membership } = derive(MIXED);
    const truthful = [...membership.clusters[0].refs];
    const outcome = validateObservationMembership(MIXED, membership);
    membership.clusters[0].refs.push(5);
    membership.clusters.pop();
    expect(outcome.membership.clusters[0].refs).toEqual(truthful);
    expect(outcome.membership.clusters).toHaveLength(2);
    expect(
      selectClusterObservations(MIXED, outcome.membership, {
        origin: ORIGIN,
        method: "GET",
        pathPattern: outcome.membership.clusters[0].pathPattern,
      }),
    ).toEqual(truthful.map((ref) => MIXED[ref]));
  });

  it("accepts membership derived under non-default options when given them", () => {
    const options = { minDistinct: 2 };
    const rows = [observation("/clients/101"), observation("/clients/102")];
    const { membership } = derive(rows, options);
    expect(validateObservationMembership(rows, membership, options).valid).toBe(
      true,
    );
    expect(validateObservationMembership(rows, membership).reasons).not.toEqual(
      [],
    );
  });

  it("rejects forged extra support", () => {
    expect(
      reasonsFor(MIXED, (membership) => membership.clusters[0].refs.push(5)),
    ).toContain("forged_reference");
  });

  it("rejects omitted support", () => {
    expect(
      reasonsFor(MIXED, (membership) => membership.clusters[0].refs.pop()),
    ).toContain("support_omitted");
  });

  it("is not satisfied by a correct count of wrong references", () => {
    const result = reasonsFor(MIXED, (membership) => {
      const [first, second] = membership.clusters;
      const swapped = first.refs;
      first.refs = second.refs;
      second.refs = swapped;
    });
    expect(result).toContain("forged_reference");
    expect(result).toContain("support_omitted");
  });

  it.each([
    ["negative", -1],
    ["out of range", 99],
    ["fractional", 1.5],
    ["textual", "0"],
  ])("rejects a %s reference", (_label, ref) => {
    expect(
      reasonsFor(MIXED, (membership) => {
        membership.clusters[0].refs = [ref];
      }),
    ).toContain("reference_out_of_range");
  });

  it("rejects duplicated references inside one cluster", () => {
    expect(
      reasonsFor(MIXED, (membership) => {
        membership.clusters[0].refs = [
          membership.clusters[0].refs[0],
          membership.clusters[0].refs[0],
        ];
      }),
    ).toContain("duplicate_reference");
  });

  it("rejects a reference claimed by two clusters", () => {
    expect(
      reasonsFor(MIXED, (membership) => {
        membership.clusters[1].refs = [
          ...membership.clusters[1].refs,
          membership.clusters[0].refs[0],
        ];
      }),
    ).toContain("reference_conflict");
  });

  it("rejects a reference claimed as both excluded and supporting", () => {
    const rows = [
      observation("/clients/101"),
      observation("/clients/102"),
      observation("/clients/103"),
      observation("/clients/104", { method: "POST" }),
    ];
    expect(
      reasonsFor(rows, (membership) => {
        membership.clusters[0].refs.push(3);
      }),
    ).toContain("reference_conflict");
  });

  it("rejects cross-origin attribution", () => {
    const rows = [
      ...CLIENTS,
      ...[1, 2, 3].map((id) =>
        observation(`/clients/${id}`, { origin: OTHER }),
      ),
    ];
    expect(
      reasonsFor(rows, (membership) => {
        const [first, second] = membership.clusters;
        first.refs = [...first.refs.slice(1), second.refs[0]];
        second.refs = [...second.refs.slice(1), 0];
      }),
    ).toContain("origin_mismatch");
  });

  it("rejects method mismatch", () => {
    const rows = [
      ...CLIENTS,
      ...[1, 2, 3].map((id) =>
        observation(`/clients/${id}`, { method: "HEAD" }),
      ),
    ];
    expect(
      reasonsFor(rows, (membership) => {
        const [first, second] = membership.clusters;
        first.refs = [...first.refs.slice(1), second.refs[0]];
        second.refs = [...second.refs.slice(1), first.refs[0]];
      }),
    ).toContain("method_mismatch");
  });

  it("rejects stale membership taken from a different snapshot", () => {
    const { membership } = derive(MIXED);
    expect(
      validateObservationMembership(MIXED.slice(0, 5), membership).reasons,
    ).toEqual(["stale_observation_count"]);
  });

  it("rejects an unknown cluster", () => {
    expect(
      reasonsFor(MIXED, (membership) => {
        membership.clusters.push({
          origin: ORIGIN,
          method: "GET",
          pathPattern: "/invented/:id",
          refs: [0],
        });
      }),
    ).toContain("cluster_unknown");
  });

  it("rejects a missing cluster", () => {
    expect(
      reasonsFor(MIXED, (membership) => {
        membership.clusters.shift();
      }),
    ).toContain("cluster_missing");
  });

  it("rejects duplicated cluster entries", () => {
    expect(
      reasonsFor(MIXED, (membership) => {
        membership.clusters.push(clone(membership.clusters[0]));
      }),
    ).toContain("malformed_membership");
  });

  it("rejects rewritten exclusion evidence", () => {
    const rows = [
      observation("/clients/101"),
      observation("/clients/102"),
      observation("/clients/103"),
      observation("/clients/104", { method: "POST" }),
    ];
    expect(
      reasonsFor(rows, (membership) => {
        membership.excluded = [{ ref: 3, reason: "observation_limit" }];
      }),
    ).toContain("excluded_mismatch");
    expect(
      reasonsFor(rows, (membership) => {
        membership.excluded = [];
      }),
    ).toContain("excluded_mismatch");
  });

  it.each([
    ["null membership", null],
    ["array membership", []],
    ["missing clusters", { observationCount: 6, excluded: [] }],
    [
      "non-array refs",
      {
        observationCount: 6,
        excluded: [],
        clusters: [
          { origin: ORIGIN, method: "GET", pathPattern: "/x", refs: 3 },
        ],
      },
    ],
    [
      "empty refs",
      {
        observationCount: 6,
        excluded: [],
        clusters: [
          { origin: ORIGIN, method: "GET", pathPattern: "/x", refs: [] },
        ],
      },
    ],
    [
      "missing pathPattern",
      {
        observationCount: 6,
        excluded: [],
        clusters: [{ origin: ORIGIN, method: "GET", refs: [0] }],
      },
    ],
    [
      "malformed exclusion",
      {
        observationCount: 6,
        excluded: [{ reason: "invalid_observation" }],
        clusters: [],
      },
    ],
  ])("fails closed on %s", (_label, membership) => {
    const outcome = validateObservationMembership(MIXED, membership);
    expect(outcome.valid).toBe(false);
    expect(outcome.reasons).toContain("malformed_membership");
  });

  it("fails closed on invalid observation input", () => {
    expect(validateObservationMembership(null, {}).reasons).toEqual([
      "invalid_observations",
    ]);
  });

  it("bounds work by the existing observation limit", () => {
    const rows = Array.from({ length: 1001 }, (_, index) =>
      observation(`/clients/${index + 100}`),
    );
    expect(validateObservationMembership(rows, {}).reasons).toEqual([
      "observation_limit",
    ]);
  });

  it("rejects a membership larger than the observation budget", () => {
    expect(
      reasonsFor(MIXED, (membership) => {
        membership.clusters = Array.from({ length: 1001 }, () =>
          clone(membership.clusters[0]),
        );
      }),
    ).toEqual(["malformed_membership"]);
  });

  it("bounds the number of accepted references", () => {
    expect(
      reasonsFor(MIXED, (membership) => {
        membership.clusters = Array.from({ length: 400 }, () =>
          clone(membership.clusters[0]),
        );
      }),
    ).toContain("reference_budget");
  });

  it("reports only sanitized reason codes", () => {
    const mutations = [
      (membership) => membership.clusters[0].refs.push(5),
      (membership) => membership.clusters[0].refs.pop(),
      (membership) => membership.clusters.shift(),
      (membership) => {
        membership.clusters[0].refs = [42];
      },
    ];
    for (const mutate of mutations)
      for (const reason of reasonsFor(MIXED, mutate)) {
        expect(MEMBERSHIP_REASON_CODES).toContain(reason);
        expect(reason).toMatch(/^[a-z_]+$/);
      }
  });

  it("returns a sorted deduplicated reason list", () => {
    const outcome = validateObservationMembership(
      MIXED,
      (() => {
        const { membership } = derive(MIXED);
        membership.clusters[0].refs = [-1, -2];
        return membership;
      })(),
    );
    expect(outcome.reasons).toEqual([...outcome.reasons].sort());
    expect(new Set(outcome.reasons).size).toBe(outcome.reasons.length);
  });

  it("reports membership as unavailable when clustering rejects the snapshot", () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      observation(`/clients/${index + 100}`),
    );
    const { membership } = derive(rows);
    const outcome = validateObservationMembership(rows, membership, {
      maxSegments: 1,
    });
    expect(outcome.valid).toBe(false);
  });
});

describe("selectClusterObservations", () => {
  function capability(observations, options) {
    const { result, membership } = derive(observations, options);
    const outcome = validateObservationMembership(
      observations,
      membership,
      options,
    );
    return { result, validated: outcome.membership };
  }

  it("returns the supporting observations in ascending reference order", () => {
    const { result, validated } = capability(MIXED);
    const cluster = result.clusters.find(
      ({ pathPattern }) => pathPattern === "/workouts/:id",
    );
    const selected = selectClusterObservations(MIXED, validated, cluster);
    expect(selected).toEqual([MIXED[3], MIXED[4], MIXED[5]]);
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it("returns null for an unknown or unsafe cluster key", () => {
    const { validated } = capability(MIXED);
    expect(
      selectClusterObservations(MIXED, validated, {
        origin: ORIGIN,
        method: "GET",
        pathPattern: "/nope/:id",
      }),
    ).toBeNull();
    expect(
      selectClusterObservations(MIXED, validated, {
        origin: OTHER,
        method: "GET",
        pathPattern: "/clients/:id",
      }),
    ).toBeNull();
    expect(selectClusterObservations(MIXED, null, {})).toBeNull();
    expect(selectClusterObservations(MIXED, validated, null)).toBeNull();
    expect(selectClusterObservations(null, validated, {})).toBeNull();
  });

  it("refuses membership that this module did not validate", () => {
    const { result, membership } = derive(MIXED);
    expect(
      selectClusterObservations(MIXED, membership, result.clusters[0]),
    ).toBeNull();
    const forged = {
      observationCount: MIXED.length,
      clusters: [
        {
          origin: ORIGIN,
          method: "GET",
          pathPattern: "/clients/:id",
          refs: [0, 1, 2, 3, 4, 5],
        },
      ],
      excluded: [],
    };
    expect(
      selectClusterObservations(MIXED, forged, forged.clusters[0]),
    ).toBeNull();
  });

  it("refuses a capability bound to a different snapshot array", () => {
    const { result, validated } = capability(MIXED);
    expect(
      selectClusterObservations([...MIXED], validated, result.clusters[0]),
    ).toBeNull();
  });

  it.each([
    [
      "a replaced observation",
      (rows) => {
        rows[0] = observation("/clients/999");
      },
    ],
    [
      "a removed observation",
      (rows) => {
        rows.pop();
      },
    ],
    [
      "an appended observation",
      (rows) => {
        rows.push(observation("/clients/999"));
      },
    ],
    [
      "a reordered snapshot",
      (rows) => {
        [rows[0], rows[5]] = [rows[5], rows[0]];
      },
    ],
  ])("refuses a snapshot mutated after validation: %s", (_label, mutate) => {
    const rows = [...MIXED];
    const { result, validated } = capability(rows);
    expect(
      selectClusterObservations(rows, validated, result.clusters[0]),
    ).not.toBeNull();
    mutate(rows);
    expect(
      selectClusterObservations(rows, validated, result.clusters[0]),
    ).toBeNull();
  });
});
