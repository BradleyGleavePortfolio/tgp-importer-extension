import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, normalizeCaptureSnapshot } from "../shared/blueprint/input.js";

function entry(overrides = {}) {
    return {
        url: "https://coach.example/api/v2/clients?page=2&cursor=private",
        method: "GET",
        statusCode: 200,
        capturedAt: "2026-09-09T20:00:00.000Z",
        requestHeaders: {
            Accept: "application/json",
            Authorization: "<redacted>",
            Cookie: "[REDACTED]",
        },
        responseBody: JSON.stringify({
            clients: [{ id: 7, name: "Dana Coach", email: "dana@private.test" }],
            access_token: "[REDACTED]",
        }),
        ...overrides,
    };
}

function reasons(result) {
    return Object.fromEntries(result.excluded.map(({ reason, count }) => [reason, count]));
}

describe("normalizeCaptureSnapshot — accepted structural evidence", () => {
    it("normalizes a safe HTTPS GET observation without retaining query values", () => {
        const result = normalizeCaptureSnapshot([entry()]);
        expect(result.excluded).toEqual([]);
        expect(result.observations).toHaveLength(1);
        expect(result.observations[0]).toMatchObject({
            origin: "https://coach.example",
            path: "/api/v2/clients",
            queryKeys: ["cursor", "page"],
            method: "GET",
            status: 200,
            capturedAt: "2026-09-09T20:00:00.000Z",
            headers: {
                accept: "application/json",
                authorization: "[REDACTED]",
                cookie: "[REDACTED]",
            },
        });
        expect(JSON.stringify(result)).not.toContain("cursor=private");
    });

    it("accepts HEAD case-insensitively", () => {
        const result = normalizeCaptureSnapshot([entry({ method: "head" })]);
        expect(result.observations[0].method).toBe("HEAD");
    });

    it("normalizes both capture-layer redaction marker spellings", () => {
        const result = normalizeCaptureSnapshot([entry({
            requestHeaders: { Authorization: "<REDACTED>" },
            responseBody: JSON.stringify({
                token: "<redacted>",
                nested: { password: "[REDACTED]" },
            }),
        })]);
        expect(result.observations[0].headers.authorization).toBe("[REDACTED]");
        expect(result.observations[0].body.token).toBe("[REDACTED]");
        expect(result.observations[0].body.nested.password).toBe("[REDACTED]");
    });

    it("preserves null, array, object, and scalar JSON for shape analysis", () => {
        const body = { nil: null, list: [1, "x", true], object: { z: 1, a: false } };
        const result = normalizeCaptureSnapshot([entry({ responseBody: JSON.stringify(body) })]);
        expect(result.observations[0].body).toEqual(body);
        expect(Object.keys(result.observations[0].body.object)).toEqual(["a", "z"]);
    });

    it("normalizes invalid status and timestamp metadata to null", () => {
        const result = normalizeCaptureSnapshot([entry({
            statusCode: 999,
            capturedAt: "x".repeat(65),
        })]);
        expect(result.observations[0].status).toBeNull();
        expect(result.observations[0].capturedAt).toBeNull();
    });

    it("is byte-identical for capture permutations", () => {
        const a = entry({ url: "https://coach.example/b?z=secret&a=also-secret" });
        const b = entry({
            url: "https://coach.example/a",
            capturedAt: "2026-09-09T19:00:00.000Z",
            responseBody: "{\"z\":1,\"a\":2}",
        });
        expect(JSON.stringify(normalizeCaptureSnapshot([a, b])))
            .toBe(JSON.stringify(normalizeCaptureSnapshot([b, a])));
    });

    it("keeps mixed safe origins separate for same-origin downstream clustering", () => {
        const result = normalizeCaptureSnapshot([
            entry({ url: "https://one.example/api/items" }),
            entry({ url: "https://two.example/api/items" }),
        ]);
        expect(result.excluded).toEqual([]);
        expect(result.observations.map((item) => item.origin))
            .toEqual(["https://one.example", "https://two.example"]);
    });
});

describe("normalizeCaptureSnapshot — fail-closed entry validation", () => {
    it.each([
        ["plain HTTP", { url: "http://coach.example/api" }, "unsafe_url"],
        ["embedded username", { url: "https://user@coach.example/api" }, "unsafe_url"],
        ["malformed URL", { url: "not a url" }, "invalid_url"],
        ["empty URL", { url: "" }, "invalid_url"],
        ["POST", { method: "POST" }, "unsupported_method"],
        ["PATCH", { method: "PATCH" }, "unsupported_method"],
        ["missing body", { responseBody: undefined }, "invalid_body"],
        ["malformed JSON", { responseBody: "{\"broken\":" }, "malformed_json"],
        ["raw auth header", { requestHeaders: { Authorization: "Bearer real-secret" } }, "unredacted_sensitive_header"],
        ["raw cookie", { requestHeaders: { Cookie: "sid=real-secret" } }, "unredacted_sensitive_header"],
        ["raw body token", { responseBody: "{\"token\":\"real-secret\"}" }, "unredacted_sensitive_field"],
        ["raw nested password", { responseBody: "{\"profile\":{\"password\":\"real-secret\"}}" }, "unredacted_sensitive_field"],
        ["invalid header value", { requestHeaders: { Accept: "ok\r\nInjected: yes" } }, "invalid_header"],
    ])("excludes %s with an explicit reason", (_label, overrides, reason) => {
        const result = normalizeCaptureSnapshot([entry(overrides)]);
        expect(result.observations).toEqual([]);
        expect(reasons(result)).toEqual({ [reason]: 1 });
    });

    it("rejects prototype-like body keys at any depth", () => {
        const cases = [
            "{\"__proto__\":{\"polluted\":true}}",
            "{\"safe\":{\"constructor\":{\"polluted\":true}}}",
            "{\"safe\":[{\"prototype\":\"bad\"}]}",
        ];
        for (const responseBody of cases) {
            const result = normalizeCaptureSnapshot([entry({ responseBody })]);
            expect(reasons(result)).toEqual({ prototype_key: 1 });
        }
        expect({}.polluted).toBeUndefined();
    });

    it("rejects prototype-like header names", () => {
        const headers = Object.create(null);
        headers.__proto__ = "value";
        const result = normalizeCaptureSnapshot([entry({ requestHeaders: headers })]);
        expect(reasons(result)).toEqual({ invalid_header: 1 });
    });

    it("counts repeated rejection reasons without retaining rejected values", () => {
        const secret = "never-store-this-secret";
        const result = normalizeCaptureSnapshot([
            entry({ method: "DELETE", responseBody: JSON.stringify({ value: secret }) }),
            entry({ method: "DELETE", responseBody: JSON.stringify({ value: secret }) }),
        ]);
        expect(result.excluded).toEqual([{ reason: "unsupported_method", count: 2 }]);
        expect(JSON.stringify(result)).not.toContain(secret);
    });

    it("reports a non-array snapshot explicitly", () => {
        expect(normalizeCaptureSnapshot({ entries: [] })).toEqual({
            observations: [],
            excluded: [{ reason: "invalid_snapshot", count: 1 }],
        });
    });
});

describe("normalizeCaptureSnapshot — bounded work", () => {
    it("caps entries and reports the omitted count", () => {
        const result = normalizeCaptureSnapshot(
            [entry({ url: "https://coach.example/1" }), entry({ url: "https://coach.example/2" })],
            { maxEntries: 1 },
        );
        expect(result.observations).toHaveLength(1);
        expect(reasons(result)).toEqual({ entry_limit: 1 });
    });

    it("rejects a body beyond the byte budget before parsing", () => {
        const result = normalizeCaptureSnapshot(
            [entry({ responseBody: JSON.stringify({ text: "abcdef" }) })],
            { maxBodyBytes: 8 },
        );
        expect(reasons(result)).toEqual({ body_byte_limit: 1 });
    });

    it("rejects excessive nesting", () => {
        const result = normalizeCaptureSnapshot(
            [entry({ responseBody: "{\"a\":{\"b\":{\"c\":1}}}" })],
            { maxDepth: 1 },
        );
        expect(reasons(result)).toEqual({ body_depth_limit: 1 });
    });

    it("rejects arrays beyond the collection bound", () => {
        const result = normalizeCaptureSnapshot(
            [entry({ responseBody: JSON.stringify([1, 2, 3]) })],
            { maxArrayLength: 2 },
        );
        expect(reasons(result)).toEqual({ body_collection_limit: 1 });
    });

    it("rejects objects beyond the collection bound", () => {
        const result = normalizeCaptureSnapshot(
            [entry({ responseBody: JSON.stringify({ a: 1, b: 2, c: 3 }) })],
            { maxObjectKeys: 2 },
        );
        expect(reasons(result)).toEqual({ body_collection_limit: 1 });
    });

    it("rejects a body beyond the total node budget", () => {
        const result = normalizeCaptureSnapshot(
            [entry({ responseBody: JSON.stringify({ a: [1, 2], b: 3 }) })],
            { maxNodes: 3 },
        );
        expect(reasons(result)).toEqual({ body_node_limit: 1 });
    });

    it("rejects strings beyond the string budget", () => {
        const result = normalizeCaptureSnapshot(
            [entry({ responseBody: JSON.stringify({ text: "abcd" }) })],
            { maxStringLength: 3 },
        );
        expect(reasons(result)).toEqual({ body_string_limit: 1 });
    });

    it("rejects too many headers", () => {
        const result = normalizeCaptureSnapshot(
            [entry({ requestHeaders: { A: "1", B: "2" } })],
            { maxHeaders: 1 },
        );
        expect(reasons(result)).toEqual({ header_limit: 1 });
    });

    it("uses the documented positive defaults when options are invalid", () => {
        const result = normalizeCaptureSnapshot([entry()], {
            maxEntries: 0,
            maxDepth: -1,
            maxNodes: "many",
        });
        expect(result.observations).toHaveLength(1);
        expect(DEFAULT_LIMITS.maxEntries).toBe(1000);
        expect(DEFAULT_LIMITS.maxDepth).toBe(8);
    });
});
