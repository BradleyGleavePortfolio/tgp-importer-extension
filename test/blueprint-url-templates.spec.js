import { describe, expect, it } from "vitest";
import {
    candidateKind,
    inferUrlTemplates,
    SUPPORTED_QUERY_KEYS,
} from "../shared/blueprint/url-templates.js";
import { normalizeBlueprint } from "../shared/replay/blueprint.js";
import { runReplay } from "../shared/replay/engine.js";

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
        ["AB12CD", "opaque"],
        ["9Z8Y7X6W", "opaque"],
        ["abc123", "opaque"],
        ["cuid_123456", "opaque"],
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
        "550e8400-e29b-01d4-a716-446655440000",
    ])("does not classify false identifier %s", (value) => {
        expect(candidateKind(value)).toBeNull();
    });

    it("requires six characters for an opaque identifier", () => {
        expect(candidateKind("A1b2C")).toBeNull();
        expect(candidateKind("A1b2C3")).toBe("opaque");
    });

    it.each([
        "550e8400-e29b-11d4-a716-446655440000",
        "550e8400-e29b-21d4-a716-446655440000",
        "550e8400-e29b-31d4-a716-446655440000",
        "550e8400-e29b-41d4-a716-446655440000",
        "550e8400-e29b-51d4-a716-446655440000",
        "1ef08b2a-ac27-6c6e-8f12-123456789abc",
        "018f08b2-aac2-7c6e-8f12-123456789abc",
        "018f08b2-aac2-8c6e-8f12-123456789abc",
        "018F08B2-AAC2-7C6E-8F12-123456789ABC",
    ])("recognizes RFC 9562 UUID version/uppercase case %s", (value) => {
        expect(candidateKind(value)).toBe("uuid");
    });

    it.each([
        "00000000-0000-0000-0000-000000000000",
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
        "018f08b2-aac2-9c6e-8f12-123456789abc",
        "018f08b2-aac2-7c6e-7f12-123456789abc",
        "018f08b2-aac2-7c6e-cf12-123456789abc",
    ])("rejects nil/max/invalid UUID policy case %s", (value) => {
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
                pathPattern: "/{s4}/v2/{s5}/:id",
                dynamicSegments: 1,
                replayCompatible: true,
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
        expect(cluster.pathPattern).toBe("/{s4}/v2/{s5}/:id");
        expect(cluster.pathPattern).not.toContain("101");
    });

    it("collapses UUID detail routes", () => {
        const ids = [
            "550e8400-e29b-41d4-a716-446655440000",
            "550e8400-e29b-41d4-a716-446655440001",
            "550e8400-e29b-41d4-a716-446655440002",
        ];
        const result = inferUrlTemplates(ids.map((id) => observation(`/records/${id}`)));
        expect(result.clusters.map((item) => item.pathPattern)).toEqual(["/{s4}/:id"]);
    });

    it("collapses uppercase short identifiers", () => {
        const result = inferUrlTemplates([
            observation("/records/AB12CD"),
            observation("/records/EF34GH"),
            observation("/records/IJ56KL"),
        ]);
        expect(result.clusters[0].pathPattern).toBe("/{s4}/:id");
    });

    it.each([
        ["lowercase", ["abc123", "xyz789", "def456"]],
        ["mixed", ["Abc123", "Xyz789", "Def456"]],
        ["ULID-like", ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "01ARZ3NDEKTSV4RRFFQ69G5FB", "01ARZ3NDEKTSV4RRFFQ69G5FC"]],
        ["cuid-like", ["cuid_123456", "cuid_234567", "cuid_345678"]],
        ["nanoid-like", ["a1_b2-c3", "d4_e5-f6", "g7_h8-i9"]],
    ])("uses repeated evidence for %s opaque identifiers", (_label, ids) => {
        const result = inferUrlTemplates(ids.map((id) => observation(`/records/${id}`)));
        expect(result.clusters).toHaveLength(1);
        expect(result.clusters[0]).toMatchObject({
            pathPattern: expect.stringMatching(/^\/\{s\d+\}\/:id$/),
            dynamicSegments: 1,
            replayCompatible: true,
            observations: 3,
        });
    });

    it("does not collapse one-off numerics", () => {
        const result = inferUrlTemplates([observation("/reports/2025")]);
        expect(result.clusters).toEqual([{
            origin: "https://coach.example",
            method: "GET",
            pathPattern: "/{s2}/{s1}",
            dynamicSegments: 0,
            replayCompatible: true,
            queryKeys: [],
            observations: 1,
        }]);
    });

    it("does not collapse two distinct values under the default support threshold", () => {
        const result = inferUrlTemplates([
            observation("/clients/1"),
            observation("/clients/2"),
        ]);
        expect(result.clusters.map((item) => item.pathPattern)).toEqual([
            "/{s3}/{s1}",
            "/{s3}/{s2}",
        ]);
    });

    it("allows an explicit threshold of two", () => {
        const result = inferUrlTemplates([
            observation("/clients/1"),
            observation("/clients/2"),
        ], { minDistinct: 2 });
        expect(result.clusters[0].pathPattern).toBe("/{s3}/:id");
    });

    it("does not mistake dates or decimals for IDs", () => {
        const result = inferUrlTemplates([
            observation("/reports/2026-09-09/rate/1.25"),
            observation("/reports/2026-09-10/rate/2.50"),
            observation("/reports/2026-09-11/rate/3.75"),
        ]);
        expect(result.clusters.map((item) => item.pathPattern)).toEqual([
            "/{s2}/{date}/{s1}/{decimal}",
            "/{s2}/{date}/{s1}/{decimal}",
            "/{s2}/{date}/{s1}/{decimal}",
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
                pathPattern: "/{s4}/:id",
                dynamicSegments: 1,
                replayCompatible: true,
                queryKeys: [],
                observations: 2,
            },
            {
                origin: "https://two.example",
                method: "GET",
                pathPattern: "/{s4}/{s3}",
                dynamicSegments: 0,
                replayCompatible: true,
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
        expect(result.clusters.map(({ method, pathPattern }) => ({ method, pathPattern }))).toEqual([
            { method: "GET", pathPattern: "/{s5}/:id" },
            { method: "HEAD", pathPattern: "/{s5}/{s4}" },
        ]);
    });

    it("does not merge resource families merely because both end in IDs", () => {
        const result = inferUrlTemplates([
            ...[1, 2, 3].map((id) => observation(`/clients/${id}`)),
            ...[1, 2, 3].map((id) => observation(`/programs/${id}`)),
        ]);
        expect(result.clusters.map((item) => item.pathPattern)).toEqual([
            "/{s4}/:id",
            "/{s5}/:id",
        ]);
    });

    it("marks multiple dynamic positions fail-closed for the single-value replay contract", () => {
        const result = inferUrlTemplates([
            observation("/clients/1/workouts/100"),
            observation("/clients/2/workouts/101"),
            observation("/clients/3/workouts/102"),
        ]);
        expect(result.clusters[0]).toMatchObject({
            pathPattern: "/{s7}/:id/{s8}/:id",
            dynamicSegments: 2,
            replayCompatible: false,
            reason: "multiple_dynamic_segments",
        });
        expect(result.clusters[0]).not.toHaveProperty("template");
    });

    it("fails closed through normalizeBlueprint and runReplay for independent parent/child IDs", async () => {
        const cluster = inferUrlTemplates([
            observation("/clients/1/workouts/100"),
            observation("/clients/2/workouts/101"),
            observation("/clients/3/workouts/102"),
        ]).clusters[0];
        const blueprint = {
            platform: "auto:test",
            apiBase: "https://coach.example",
            steps: [{
                id: "independent",
                entityType: "record",
                template: cluster.template,
                forEach: "parentIds",
            }],
        };
        expect(cluster.replayCompatible).toBe(false);
        expect(() => normalizeBlueprint(blueprint, {
            allowedOrigins: ["https://coach.example"],
        })).toThrow("template is required");
        let fetches = 0;
        await expect(runReplay({
            blueprint,
            allowedOrigins: ["https://coach.example"],
            fetchJson: async () => { fetches += 1; return []; },
            emit: async () => {},
        })).rejects.toThrow("template is required");
        expect(fetches).toBe(0);
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
        expect(result.clusters.map((item) => item.pathPattern)).toEqual([
            "/{s10}/{s1}/{s9}/:id",
            "/{s10}/{s5}/{s9}/:id",
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

    it("selects the same bounded observations for every permutation", () => {
        const rows = [
            observation("/clients/3"),
            observation("/clients/1"),
            observation("/clients/2"),
        ];
        const forward = inferUrlTemplates(rows, { maxObservations: 2 });
        const reverse = inferUrlTemplates([...rows].reverse(), { maxObservations: 2 });
        expect(forward).toEqual(reverse);
        expect(forward.excluded).toEqual([{ reason: "observation_limit", count: 1 }]);
    });

    it.each([
        [1, 1, 0], [2, 2, 0], [3, 2, 1],
    ])("enforces maxObservations at limit-1/limit/limit+1 (%i)", (count, kept, omitted) => {
        const rows = Array.from({ length: count }, (_, i) => observation(`/items/${i + 1}`));
        const result = inferUrlTemplates(rows, { maxObservations: 2 });
        expect(result.clusters.reduce((sum, row) => sum + row.observations, 0)).toBe(kept);
        expect(result.excluded).toEqual(omitted
            ? [{ reason: "observation_limit", count: omitted }]
            : []);
    });

    it("does not depend on localeCompare for contractual ordering", () => {
        const original = String.prototype.localeCompare;
        String.prototype.localeCompare = () => {
            throw new Error("host locale must not be consulted");
        };
        try {
            const result = inferUrlTemplates([
                observation("/ä/abc123"),
                observation("/z/xyz789"),
            ]);
            expect(result.clusters).toHaveLength(2);
        }
        finally {
            String.prototype.localeCompare = original;
        }
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
        ["localhost origin", [observation("/x", { origin: "https://localhost" })], "invalid_observation"],
        ["IP-literal origin", [observation("/x", { origin: "https://127.0.0.1" })], "invalid_observation"],
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

    it.each([
        "/clients/550e8400-e29b-41d4-a716-446655440000",
        "/reset/abcdefghijklmnopqrstuvwxyz0123456789",
        "/users/DanaCoach",
        "/users/danacoach",
        "/invite/opaqueTokenABC123",
        "/phone/%2B15558675309",
        "/users/%EF%BC%A4%EF%BD%81%EF%BD%8E%EF%BD%81",
    ])("content-minimizes one-off path value %s", (path) => {
        const result = inferUrlTemplates([observation(path)]);
        const serialized = JSON.stringify(result);
        const raw = decodeURIComponent(path).split("/").at(-1);
        expect(result.clusters).toHaveLength(1);
        expect(serialized).not.toContain(raw);
        expect(result.clusters[0].pathPattern).toMatch(/\{s\d+\}$/);
    });

    it("bounds observation work and reports the omitted count", () => {
        const result = inferUrlTemplates([
            observation("/clients/1"),
            observation("/clients/2"),
            observation("/clients/3"),
        ], { maxObservations: 2 });
        expect(result.excluded).toEqual([{ reason: "observation_limit", count: 1 }]);
        expect(result.clusters.map((item) => item.pathPattern)).toEqual([
            "/{s3}/{s1}",
            "/{s3}/{s2}",
        ]);
    });

    it("bounds path-segment work", () => {
        const result = inferUrlTemplates([observation("/a/b/c")], { maxSegments: 2 });
        expect(result.clusters).toEqual([]);
        expect(result.excluded).toEqual([{ reason: "invalid_observation", count: 1 }]);
    });

    it.each([
        [1, false], [2, false], [3, true],
    ])("enforces maxSegments at limit-1/limit/limit+1 (%i)", (count, excluded) => {
        const result = inferUrlTemplates([
            observation("/" + Array.from({ length: count }, (_, i) => `part${i}`).join("/")),
        ], { maxSegments: 2 });
        expect(result.clusters.length === 0).toBe(excluded);
        expect(result.excluded).toEqual(excluded
            ? [{ reason: "invalid_observation", count: 1 }]
            : []);
    });

    it("clamps extreme caller options to absolute URL ceilings", () => {
        const path = "/" + Array.from({ length: 33 }, (_, i) => `part${i}`).join("/");
        const result = inferUrlTemplates([observation(path)], {
            maxSegments: Number.MAX_SAFE_INTEGER,
            maxObservations: Number.MAX_SAFE_INTEGER,
            minDistinct: Number.MAX_SAFE_INTEGER,
        });
        expect(result).toEqual({
            clusters: [],
            excluded: [{ reason: "invalid_observation", count: 1 }],
        });
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
        expect(result.clusters[0].pathPattern).toBe("/{s4}/:id");
        expect(JSON.stringify(result)).not.toContain(secret);
    });
});
