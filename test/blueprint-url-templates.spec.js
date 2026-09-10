import { describe, expect, it } from "vitest";
import {
  candidateKind,
  inferUrlTemplates,
  SUPPORTED_QUERY_KEYS,
} from "../shared/blueprint/url-templates.js";
import { normalizeBlueprint } from "../shared/replay/blueprint.js";

function observation(path, overrides = {}) {
  return {
    origin: "https://coach.example",
    path,
    queryKeys: [],
    method: "GET",
    ...overrides,
  };
}
function paths(rows, options) {
  return inferUrlTemplates(rows, options).clusters.map(
    (cluster) => cluster.pathPattern,
  );
}

describe("candidateKind", () => {
  it.each([
    ["550e8400-e29b-41d4-a716-446655440000", "uuid"],
    ["123", "integer"],
    ["0", "integer"],
    ["AB12CD", "opaque"],
    ["abc123", "opaque"],
    ["cuid_123456", "opaque"],
  ])("recognizes supported identifier %s", (value, expected) => {
    expect(candidateKind(value)).toBe(expected);
  });

  it.each([
    "2023",
    "2024",
    "2025",
    "2026-09",
    "2026-09-09",
    "1.25",
    "v2",
    "clients",
    "ABCDEF",
    "-4",
    "01",
    "550e8400-e29b-01d4-a716-446655440000",
  ])("does not classify false identifier %s", (value) => {
    expect(candidateKind(value)).toBeNull();
  });

  it.each([
    "550e8400-e29b-11d4-a716-446655440000",
    "018f08b2-aac2-7c6e-8f12-123456789abc",
    "018F08B2-AAC2-8C6E-8F12-123456789ABC",
  ])("recognizes valid RFC 9562 UUID %s", (value) => {
    expect(candidateKind(value)).toBe("uuid");
  });
});

describe("inferUrlTemplates — literal replay evidence", () => {
  it("retains real static route literals and collapses a supported ID", () => {
    const result = inferUrlTemplates(
      [101, 102, 103].map((id) => observation(`/alice/api/v2/clients/${id}`)),
    );
    expect(result).toEqual({
      clusters: [
        {
          origin: "https://coach.example",
          method: "GET",
          pathPattern: "/alice/api/v2/clients/:id",
          dynamicSegments: 1,
          replayCompatible: true,
          queryKeys: [],
          observations: 3,
        },
      ],
      excluded: [],
    });
  });

  it.each([
    ["numeric", ["101", "102", "103"]],
    [
      "UUID",
      [
        "550e8400-e29b-41d4-a716-446655440000",
        "550e8400-e29b-41d4-a716-446655440001",
        "550e8400-e29b-41d4-a716-446655440002",
      ],
    ],
    ["opaque", ["abc123", "xyz789", "def456"]],
  ])("emits a literal replay template for %s IDs", (_kind, ids) => {
    const cluster = inferUrlTemplates(
      ids.map((id) => observation(`/records/${id}`)),
    ).clusters[0];
    expect(cluster).toMatchObject({
      pathPattern: "/records/:id",
      dynamicSegments: 1,
      replayCompatible: true,
    });
    expect(cluster.pathPattern).not.toContain(ids[0]);
  });

  it("compiles every replay-compatible cluster into the current literal replay contract", () => {
    const clusters = inferUrlTemplates(
      [1, 2, 3].map((id) => observation(`/alice/records/${id}`)),
    ).clusters;
    for (const cluster of clusters.filter(
      ({ replayCompatible }) => replayCompatible,
    )) {
      const normalized = normalizeBlueprint(
        {
          platform: "auto:test",
          apiBase: cluster.origin,
          steps: [
            {
              id: "list",
              entityType: "record",
              template: "/records",
              itemsPath: [],
              idField: "id",
              collectAs: "recordIds",
            },
            {
              id: "records",
              entityType: "record",
              template: cluster.pathPattern,
              forEach: "recordIds",
            },
          ],
        },
        { allowedOrigins: [cluster.origin] },
      );
      expect(normalized.steps[1].template).toBe("/alice/records/:id");
    }
  });

  it("keeps cluster identity stable when unrelated evidence is added", () => {
    const rows = [1, 2, 3].map((id) => observation(`/alice/records/${id}`));
    const base = inferUrlTemplates(rows).clusters.find((item) =>
      item.pathPattern.includes("records"),
    );
    const extended = inferUrlTemplates([
      ...rows,
      observation("/unrelated/static"),
    ]).clusters.find((item) => item.pathPattern.includes("records"));
    expect(extended).toEqual(base);
  });

  it("retains approved literal slugs and canonical percent encoding", () => {
    expect(paths([observation("/coaches/alice/records")])).toEqual([
      "/coaches/alice/records",
    ]);
    expect(
      paths([observation("/coaches/%EF%BC%A4%EF%BD%81%EF%BD%8E%EF%BD%81")]),
    ).toEqual(["/coaches/%EF%BC%A4%EF%BD%81%EF%BD%8E%EF%BD%81"]);
    expect(paths([observation("/phone/%2B15558675309")])).toEqual([
      "/phone/%2B15558675309",
    ]);
  });

  it("does not collapse repeated calendar years or year-month windows", () => {
    expect(
      paths([2023, 2024, 2025].map((year) => observation(`/reports/${year}`))),
    ).toEqual(["/reports/2023", "/reports/2024", "/reports/2025"]);
    expect(
      paths(
        ["2024-01", "2024-02", "2024-03"].map((month) =>
          observation(`/reports/${month}`),
        ),
      ),
    ).toEqual(["/reports/2024-01", "/reports/2024-02", "/reports/2024-03"]);
    expect(
      paths([10, 11, 12].map((month) => observation(`/reports/2024/${month}`))),
    ).toEqual(["/reports/2024/10", "/reports/2024/11", "/reports/2024/12"]);
  });

  it("scopes the year-month guard to each literal route partition", () => {
    const rows = [
      observation("/reports/2024/10/summary"),
      observation("/reports/2024/11/summary"),
      observation("/reports/2024/12/summary"),
      observation("/items/batch/10/detail"),
      observation("/items/batch/11/detail"),
      observation("/items/batch/12/detail"),
    ];

    const result = inferUrlTemplates(rows);

    expect(
      result.clusters.map(({ pathPattern, observations }) => ({
        pathPattern,
        observations,
      })),
    ).toEqual([
      {
        pathPattern: "/items/batch/:id/detail",
        observations: 3,
      },
      {
        pathPattern: "/reports/2024/10/summary",
        observations: 1,
      },
      {
        pathPattern: "/reports/2024/11/summary",
        observations: 1,
      },
      {
        pathPattern: "/reports/2024/12/summary",
        observations: 1,
      },
    ]);
    expect(result.excluded).toEqual([]);
  });

  it("does not collapse dates or decimals", () => {
    expect(
      paths([
        observation("/reports/2026-09-09/rate/1.25"),
        observation("/reports/2026-09-10/rate/2.50"),
        observation("/reports/2026-09-11/rate/3.75"),
      ]),
    ).toEqual([
      "/reports/2026-09-09/rate/1.25",
      "/reports/2026-09-10/rate/2.50",
      "/reports/2026-09-11/rate/3.75",
    ]);
  });

  it("does not collapse below the support threshold", () => {
    expect(
      paths([observation("/clients/1"), observation("/clients/2")]),
    ).toEqual(["/clients/1", "/clients/2"]);
    expect(
      paths([observation("/clients/1"), observation("/clients/2")], {
        minDistinct: 2,
      }),
    ).toEqual(["/clients/:id"]);
  });

  it("separates origins, methods, and resource families", () => {
    const rows = [
      ...[1, 2, 3].map((id) =>
        observation(`/clients/${id}`, { origin: "https://one.example" }),
      ),
      ...[1, 2, 3].map((id) =>
        observation(`/programs/${id}`, { origin: "https://two.example" }),
      ),
      observation("/clients/4", { method: "HEAD" }),
    ];
    expect(
      inferUrlTemplates(rows).clusters.map(
        ({ origin, method, pathPattern }) => ({ origin, method, pathPattern }),
      ),
    ).toEqual([
      {
        origin: "https://coach.example",
        method: "HEAD",
        pathPattern: "/clients/4",
      },
      {
        origin: "https://one.example",
        method: "GET",
        pathPattern: "/clients/:id",
      },
      {
        origin: "https://two.example",
        method: "GET",
        pathPattern: "/programs/:id",
      },
    ]);
  });

  it("marks multiple independent dynamic positions incompatible", () => {
    const cluster = inferUrlTemplates([
      observation("/clients/1/workouts/100"),
      observation("/clients/2/workouts/101"),
      observation("/clients/3/workouts/102"),
    ]).clusters[0];
    expect(cluster).toMatchObject({
      pathPattern: "/clients/:id/workouts/:id",
      dynamicSegments: 2,
      replayCompatible: false,
      reason: "multiple_dynamic_segments",
    });
  });

  it("partitions a weak candidate position while collapsing a strong one", () => {
    expect(
      paths([
        observation("/teams/1/clients/100"),
        observation("/teams/1/clients/101"),
        observation("/teams/1/clients/102"),
        observation("/teams/2/clients/200"),
        observation("/teams/2/clients/201"),
        observation("/teams/2/clients/202"),
      ]),
    ).toEqual(["/teams/1/clients/:id", "/teams/2/clients/:id"]);
  });

  it("never borrows distinct evidence across unrelated literal partitions", () => {
    expect(
      paths(
        [
          observation("/alpha/A12345"),
          observation("/beta/B12345"),
          observation("/gamma/C12345"),
        ],
        { minDistinct: 3 },
      ),
    ).toEqual(["/alpha/A12345", "/beta/B12345", "/gamma/C12345"]);
  });

  it("is byte-identical under capture permutation", () => {
    const rows = [
      observation("/clients/3", { queryKeys: ["limit", "page"] }),
      observation("/clients/1", { queryKeys: ["cursor", "page"] }),
      observation("/clients/2", { queryKeys: ["unknown", "from"] }),
    ];
    expect(inferUrlTemplates(rows)).toEqual(
      inferUrlTemplates([...rows].reverse()),
    );
  });

  it("retains only supported sorted query-key names", () => {
    const cluster = inferUrlTemplates(
      [1, 2, 3].map((id) =>
        observation(`/clients/${id}`, {
          queryKeys: ["page", "search", "LIMIT", "cursor", "access_token"],
        }),
      ),
    ).clusters[0];
    expect(cluster.queryKeys).toEqual(["cursor", "limit", "page"]);
    expect([...SUPPORTED_QUERY_KEYS].sort()).toEqual([
      "after",
      "before",
      "cursor",
      "end",
      "from",
      "limit",
      "offset",
      "page",
      "per_page",
      "since",
      "start",
      "to",
      "until",
    ]);
  });
});

describe("inferUrlTemplates — hostile and bounded input", () => {
  it.each([
    ["non-array", null, "invalid_observations"],
    [
      "HTTP origin",
      [observation("/x", { origin: "http://coach.example" })],
      "invalid_observation",
    ],
    [
      "localhost",
      [observation("/x", { origin: "https://localhost" })],
      "invalid_observation",
    ],
    [
      "IP literal",
      [observation("/x", { origin: "https://127.0.0.1" })],
      "invalid_observation",
    ],
    ["POST", [observation("/x", { method: "POST" })], "invalid_observation"],
    ["network path", [observation("//evil.example/x")], "invalid_observation"],
    ["backslash", [observation("/safe\\evil")], "invalid_observation"],
    ["query", [observation("/safe?token=secret")], "invalid_observation"],
    ["fragment", [observation("/safe#secret")], "invalid_observation"],
    [
      "email",
      [observation("/clients/dana@example.test")],
      "invalid_observation",
    ],
    [
      "encoded email",
      [observation("/clients/dana%40example.test")],
      "invalid_observation",
    ],
    [
      "redaction marker",
      [observation("/clients/%3Credacted%3E")],
      "invalid_observation",
    ],
  ])("rejects %s without echoing input", (_label, input, reason) => {
    expect(inferUrlTemplates(input)).toEqual({
      clusters: [],
      excluded: [{ reason, count: 1 }],
    });
  });

  it("bounds observations deterministically", () => {
    const rows = [
      observation("/clients/3"),
      observation("/clients/1"),
      observation("/clients/2"),
    ];
    const forward = inferUrlTemplates(rows, { maxObservations: 2 });
    expect(forward).toEqual(
      inferUrlTemplates([...rows].reverse(), { maxObservations: 2 }),
    );
    expect(forward.excluded).toEqual([
      { reason: "observation_limit", count: 1 },
    ]);
    expect(paths(rows, { maxObservations: 2 })).toEqual([
      "/clients/1",
      "/clients/2",
    ]);
  });

  it("bounds segment and aggregate path work", () => {
    expect(
      inferUrlTemplates([observation("/a/b/c")], { maxSegments: 2 }).excluded,
    ).toEqual([{ reason: "invalid_observation", count: 1 }]);
    const tooMany = Array.from({ length: 1000 }, () =>
      observation("/" + "x".repeat(4090)),
    );
    expect(inferUrlTemplates(tooMany).excluded).toEqual([
      { reason: "path_byte_limit", count: 1000 },
    ]);
  });

  it("does not inspect an oversized query-key collection", () => {
    const queryKeys = Array.from({ length: 65 }, (_, index) => `key-${index}`);
    queryKeys[64] = "page";
    expect(
      inferUrlTemplates([observation("/clients", { queryKeys })]).clusters[0]
        .queryKeys,
    ).toEqual([]);
  });

  it("does not retain body properties", () => {
    const secret = "Dana Coach dana@private.test";
    const result = inferUrlTemplates(
      [1, 2, 3].map((id) =>
        observation(`/clients/${id}`, { body: { name: secret } }),
      ),
    );
    expect(result.clusters[0].pathPattern).toBe("/clients/:id");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
