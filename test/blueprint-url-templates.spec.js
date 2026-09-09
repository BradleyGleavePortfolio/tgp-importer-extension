import { describe, expect, it } from "vitest";
import {
    candidateKind,
    inferUrlTemplates,
    SUPPORTED_QUERY_KEYS,
} from "../shared/blueprint/url-templates.js";

function observation(path, overrides = {}) {
    return {
        origin: "https://coach.example",
        path,
        queryKeys: [],
        method: "GET",
        ...overrides,
    };
}

describe("candidateKind", () => {
    it.each([
        ["550e8400-e29b-41d4-a716-446655440000", "uuid"],
        ["123", "integer"],
        ["0", "integer"],
        ["AB12CD", "short"],
        ["9Z8Y7X6W", "short"],
    ])("recognizes supported %s identifiers", (value, expected) => {
        expect(candidateKind(value)).toBe(expected);
    });

    it.each([
        "2026-09-09",
        "1.25",
        "v2",
        "V2",
        "clients",
        "ABCDEF",
        "-4",
        "01",
        "abc123",
        "550e8400-e29b-01d4-a716-446655440000",
    ])("does not classify false identifier %s", (value) => {
        expect(candidateKind(value)).toBeNull();
    });
});

describe("inferUrlTemplates — safe deterministic clustering", () => {
    it("collapses a numeric detail segment after three distinct values", () => {
        const result = inferUrlTemplates([
            observation("/api/v2/clients/101"),
            observation("/api/v2/clients/102"),
            observation("/api/v2/clients/103"),
        ]);
        expect(result).toEqual({
            clusters: [{
                origin: "https://coach.example",
                method: "GET",
                template: "/api/v2/clients/:id",
                queryKeys: [],
                observations: 3,
            }],
            excluded: [],
        });
    });

    it("preserves the static API version while collapsing the resource id", () => {
        const [cluster] = inferUrlTemplates([
            observation("/api/v2/clients/101"),
            observation("/api/v2/clients/102"),
            observation("/api/v2/clients/103"),
        ]).clusters;
        expect(cluster.template).toBe("/api/v2/clients/:id");
        expect(cluster.template).not.toBe("/api/:id/clients/:id");
    });

    it("collapses UUID detail routes", () => {
        const ids = [
            "550e8400-e29b-41d4-a716-446655440000",
            "550e8400-e29b-41d4-a716-446655440001",
            "550e8400-e29b-41d4-a716-446655440002",
        ];
        const result = inferUrlTemplates(ids.map((id) => observation(`/records/${id}`)));
        expect(result.clusters.map((item) => item.template)).toEqual(["/records/:id"]);
    });

    it("collapses uppercase short identifiers", () => {
        const result = inferUrlTemplates([
            observation("/records/AB12CD"),
            observation("/records/EF34GH"),
            observation("/records/IJ56KL"),
        ]);
        expect(result.clusters[0].template).toBe("/records/:id");
    });

    it("does not collapse one-off numerics", () => {
        const result = inferUrlTemplates([observation("/reports/2025")]);
        expect(result.clusters).toEqual([{
            origin: "https://coach.example",
            method: "GET",
            template: "/reports/2025",
            queryKeys: [],
            observations: 1,
        }]);
    });

    it("does not collapse two distinct values under the default support threshold", () => {
        const result = inferUrlTemplates([
            observation("/clients/1"),
            observation("/clients/2"),
        ]);
        expect(result.clusters.map((item) => item.template)).toEqual([
            "/clients/1",
            "/clients/2",
        ]);
    });

    it("allows an explicit threshold of two", () => {
        const result = inferUrlTemplates([
            observation("/clients/1"),
            observation("/clients/2"),
        ], { minDistinct: 2 });
        expect(result.clusters[0].template).toBe("/clients/:id");
    });

    it("does not mistake dates or decimals for IDs", () => {
        const result = inferUrlTemplates([
            observation("/reports/2026-09-09/rate/1.25"),
            observation("/reports/2026-09-10/rate/2.50"),
            observation("/reports/2026-09-11/rate/3.75"),
        ]);
        expect(result.clusters.map((item) => item.template)).toEqual([
            "/reports/2026-09-09/rate/1.25",
            "/reports/2026-09-10/rate/2.50",
            "/reports/2026-09-11/rate/3.75",
        ]);
    });

    it("never merges observations across origins", () => {
        const result = inferUrlTemplates([
            observation("/clients/1", { origin: "https://one.example" }),
            observation("/clients/2", { origin: "https://one.example" }),
            observation("/clients/3", { origin: "https://two.example" }),
        ], { minDistinct: 2 });
        expect(result.clusters).toEqual([
            {
                origin: "https://one.example",
                method: "GET",
                template: "/clients/:id",
                queryKeys: [],
                observations: 2,
            },
            {
                origin: "https://two.example",
                method: "GET",
                template: "/clients/3",
                queryKeys: [],
                observations: 1,
            },
        ]);
    });

    it("never merges GET and HEAD evidence", () => {
        const result = inferUrlTemplates([
            observation("/clients/1"),
            observation("/clients/2"),
            observation("/clients/3"),
            observation("/clients/4", { method: "HEAD" }),
        ]);
        expect(result.clusters.map(({ method, template }) => ({ method, template }))).toEqual([
            { method: "GET", template: "/clients/:id" },
            { method: "HEAD", template: "/clients/4" },
        ]);
    });

    it("does not merge resource families merely because both end in IDs", () => {
        const result = inferUrlTemplates([
            ...[1, 2, 3].map((id) => observation(`/clients/${id}`)),
            ...[1, 2, 3].map((id) => observation(`/programs/${id}`)),
        ]);
        expect(result.clusters.map((item) => item.template)).toEqual([
            "/clients/:id",
            "/programs/:id",
        ]);
    });

    it("can collapse multiple well-supported identifier positions", () => {
        const result = inferUrlTemplates([
            observation("/clients/1/workouts/100"),
            observation("/clients/2/workouts/101"),
            observation("/clients/3/workouts/102"),
        ]);
        expect(result.clusters[0].template).toBe("/clients/:id/workouts/:id");
    });

    it("partitions a weak candidate position while collapsing a strong one", () => {
        const result = inferUrlTemplates([
            observation("/teams/1/clients/100"),
            observation("/teams/1/clients/101"),
            observation("/teams/1/clients/102"),
            observation("/teams/2/clients/200"),
            observation("/teams/2/clients/201"),
            observation("/teams/2/clients/202"),
        ]);
        expect(result.clusters.map((item) => item.template)).toEqual([
            "/teams/1/clients/:id",
            "/teams/2/clients/:id",
        ]);
    });

    it("is byte-identical regardless of capture order", () => {
        const rows = [
            observation("/clients/3", { queryKeys: ["limit", "page"] }),
            observation("/clients/1", { queryKeys: ["cursor", "page"] }),
            observation("/clients/2", { queryKeys: ["unknown", "from"] }),
        ];
        expect(JSON.stringify(inferUrlTemplates(rows)))
            .toBe(JSON.stringify(inferUrlTemplates([...rows].reverse())));
    });

    it("retains only supported query-key names, sorted, without values", () => {
        const secret = "dana@private.test";
        const result = inferUrlTemplates([
            observation("/clients/1", { queryKeys: ["page", "search", "from", secret] }),
            observation("/clients/2", { queryKeys: ["LIMIT", "cursor"] }),
            observation("/clients/3", { queryKeys: ["until", "access_token"] }),
        ]);
        expect(result.clusters[0].queryKeys).toEqual([
            "cursor", "from", "limit", "page", "until",
        ]);
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain("access_token");
    });

    it("exports the supported query vocabulary as structural evidence only", () => {
        expect([...SUPPORTED_QUERY_KEYS].sort()).toEqual([
            "after", "before", "cursor", "end", "from", "limit", "offset",
            "page", "per_page", "since", "start", "to", "until",
        ]);
    });
});

describe("inferUrlTemplates — hostile and bounded input", () => {
    it.each([
        ["non-array input", null, "invalid_observations"],
        ["unsafe origin", [observation("/x", { origin: "http://coach.example" })], "invalid_observation"],
        ["unsupported method", [observation("/x", { method: "POST" })], "invalid_observation"],
        ["network-path path", [observation("//evil.example/x")], "invalid_observation"],
        ["backslash path", [observation("/safe\\evil")], "invalid_observation"],
        ["query-bearing path", [observation("/safe?token=secret")], "invalid_observation"],
        ["fragment-bearing path", [observation("/safe#secret")], "invalid_observation"],
        ["email path", [observation("/clients/dana@example.test")], "invalid_observation"],
        ["encoded email path", [observation("/clients/dana%40example.test")], "invalid_observation"],
        ["redaction marker path", [observation("/clients/%3Credacted%3E")], "invalid_observation"],
    ])("reports %s without echoing attacker input", (_label, input, reason) => {
        const result = inferUrlTemplates(input);
        expect(result.clusters).toEqual([]);
        expect(result.excluded).toEqual([{ reason, count: 1 }]);
    });

    it("bounds observation work and reports the omitted count", () => {
        const result = inferUrlTemplates([
            observation("/clients/1"),
            observation("/clients/2"),
            observation("/clients/3"),
        ], { maxObservations: 2 });
        expect(result.excluded).toEqual([{ reason: "observation_limit", count: 1 }]);
        expect(result.clusters.map((item) => item.template)).toEqual([
            "/clients/1",
            "/clients/2",
        ]);
    });

    it("bounds path-segment work", () => {
        const result = inferUrlTemplates([observation("/a/b/c")], { maxSegments: 2 });
        expect(result.clusters).toEqual([]);
        expect(result.excluded).toEqual([{ reason: "invalid_observation", count: 1 }]);
    });

    it("does not inspect an oversized query-key collection", () => {
        const queryKeys = Array.from({ length: 65 }, (_, index) => `key-${index}`);
        queryKeys[64] = "page";
        const result = inferUrlTemplates([observation("/clients", { queryKeys })]);
        expect(result.clusters[0].queryKeys).toEqual([]);
    });

    it("does not include body PII or arbitrary observation properties", () => {
        const secret = "Dana Coach dana@private.test";
        const result = inferUrlTemplates([
            observation("/clients/1", { body: { name: secret } }),
            observation("/clients/2", { body: { name: secret } }),
            observation("/clients/3", { body: { name: secret } }),
        ]);
        expect(result.clusters[0].template).toBe("/clients/:id");
        expect(JSON.stringify(result)).not.toContain(secret);
    });
});
