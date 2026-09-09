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
                accept: "[REDACTED]",
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

    it("preserves null only for genuinely absent status and timestamp metadata", () => {
        const value = entry();
        delete value.statusCode;
        delete value.capturedAt;
        const result = normalizeCaptureSnapshot([value]);
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
        ["localhost", { url: "https://localhost/api" }, "unsafe_url"],
        ["IPv4 literal", { url: "https://127.0.0.1/api" }, "unsafe_url"],
        ["IPv6 literal", { url: "https://[::1]/api" }, "unsafe_url"],
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
        ["malformed status", { statusCode: null }, "invalid_status"],
        ["out-of-range status", { statusCode: 600 }, "invalid_status"],
        ["non-integer status", { statusCode: 200.5 }, "invalid_status"],
        ["invalid timestamp", { capturedAt: "not-a-date" }, "invalid_timestamp"],
        ["non-canonical timestamp", { capturedAt: "2026-09-09T20:00:00Z" }, "invalid_timestamp"],
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

    it("rejects case-insensitive duplicate header names deterministically", () => {
        const result = normalizeCaptureSnapshot([entry({
            requestHeaders: { Accept: "application/json", accept: "text/json" },
        })]);
        expect(reasons(result)).toEqual({ duplicate_header: 1 });
    });

    it("never retains values from non-sensitive custom headers", () => {
        const secret = "opaque-private-value";
        const result = normalizeCaptureSnapshot([entry({
            requestHeaders: { "X-Custom-Context": secret },
        })]);
        expect(result.observations[0].headers["x-custom-context"]).toBe("[REDACTED]");
        expect(JSON.stringify(result.observations[0].headers)).not.toContain(secret);
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

    it.each([
        "accessToken", "refreshToken", "auth_token", "client_secret", "sessionId",
        "session_token", "jwt", "x-api-key", "private_key", "password_hash", "credit_card",
    ])("rejects raw credential alias %s", (key) => {
        const result = normalizeCaptureSnapshot([entry({
            responseBody: JSON.stringify({ [key]: "raw-secret" }),
        })]);
        expect(result).toEqual({
            observations: [],
            excluded: [{ reason: "unredacted_sensitive_field", count: 1 }],
        });
        expect(JSON.stringify(result)).not.toContain("raw-secret");
    });

    it.each(["Bearer RAW-BEARER-SECRET", "eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.signature"])(
        "rejects credential-form value nested under an innocuous key",
        (message) => {
            const result = normalizeCaptureSnapshot([entry({
                responseBody: JSON.stringify({ message }),
            })]);
            expect(reasons(result)).toEqual({ unredacted_sensitive_value: 1 });
            expect(JSON.stringify(result)).not.toContain(message);
        },
    );

    it.each(["token_count", "secret_santa_notes", "session_count"])(
        "does not over-classify near-miss field %s",
        (key) => {
            const result = normalizeCaptureSnapshot([entry({
                responseBody: JSON.stringify({ [key]: "ordinary-data" }),
            })]);
            expect(result.excluded).toEqual([]);
            expect(result.observations[0].body[key]).toBe("ordinary-data");
        },
    );

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

    it("selects entries canonically at the cap, independent of permutation", () => {
        const values = [3, 1, 2].map((id) => entry({ url: `https://coach.example/${id}` }));
        const forward = normalizeCaptureSnapshot(values, { maxEntries: 2 });
        const reverse = normalizeCaptureSnapshot([...values].reverse(), { maxEntries: 2 });
        expect(forward).toEqual(reverse);
        expect(forward.observations.map(({ path }) => path)).toEqual(["/1", "/2"]);
    });

    it.each([
        [1, 1, 0], [2, 2, 0], [3, 2, 1],
    ])("enforces maxEntries at limit-1/limit/limit+1 (%i)", (count, kept, omitted) => {
        const values = Array.from({ length: count }, (_, i) =>
            entry({ url: `https://coach.example/${i}` }));
        const result = normalizeCaptureSnapshot(values, { maxEntries: 2 });
        expect(result.observations).toHaveLength(kept);
        expect(reasons(result)).toEqual(omitted ? { entry_limit: omitted } : {});
    });

    it.each([
        [5, true], [6, false], [7, false],
    ])("enforces maxTotalBytes at exact UTF-8 boundary %i", (bytes, excluded) => {
        const result = normalizeCaptureSnapshot(
            [entry({ responseBody: JSON.stringify("éé") })],
            { maxTotalBytes: bytes },
        );
        expect(reasons(result)).toEqual(excluded ? { snapshot_byte_limit: 1 } : {});
    });

    it.each([
        [5, true], [6, false], [7, false],
    ])("enforces maxBodyBytes at exact UTF-8 byte boundary %i", (bytes, excluded) => {
        const result = normalizeCaptureSnapshot(
            [entry({ responseBody: JSON.stringify("éé") })],
            { maxBodyBytes: bytes },
        );
        expect(reasons(result)).toEqual(excluded ? { body_byte_limit: 1 } : {});
    });

    it.each([
        [1, false], [2, false], [3, true],
    ])("enforces maxArrayLength at limit-1/limit/limit+1 (%i)", (length, excluded) => {
        const result = normalizeCaptureSnapshot(
            [entry({ responseBody: JSON.stringify(Array.from({ length }, () => 1)) })],
            { maxArrayLength: 2 },
        );
        expect(reasons(result)).toEqual(excluded ? { body_collection_limit: 1 } : {});
    });

    it.each([
        [1, false], [2, false], [3, true],
    ])("enforces maxObjectKeys at limit-1/limit/limit+1 (%i)", (length, excluded) => {
        const body = Object.fromEntries(Array.from({ length }, (_, i) => [`k${i}`, i]));
        const result = normalizeCaptureSnapshot([entry({ responseBody: JSON.stringify(body) })], {
            maxObjectKeys: 2,
        });
        expect(reasons(result)).toEqual(excluded ? { body_collection_limit: 1 } : {});
    });

    it.each([
        [1, false], [2, false], [3, true],
    ])("enforces maxHeaders at limit-1/limit/limit+1 (%i)", (length, excluded) => {
        const requestHeaders = Object.fromEntries(Array.from({ length }, (_, i) => [`X-${i}`, "v"]));
        const result = normalizeCaptureSnapshot([entry({ requestHeaders })], { maxHeaders: 2 });
        expect(reasons(result)).toEqual(excluded ? { header_limit: 1 } : {});
    });

    it.each([
        [1, false], [2, false], [3, true],
    ])("enforces maxStringLength at limit-1/limit/limit+1 (%i)", (length, excluded) => {
        const result = normalizeCaptureSnapshot(
            [entry({ responseBody: JSON.stringify({ value: "x".repeat(length) }) })],
            { maxStringLength: 2 },
        );
        expect(reasons(result)).toEqual(excluded ? { body_string_limit: 1 } : {});
    });

    it("clamps extreme caller options to absolute ceilings", () => {
        const deep = {};
        let cursor = deep;
        for (let i = 0; i < 18; i += 1) {
            cursor.next = {};
            cursor = cursor.next;
        }
        const result = normalizeCaptureSnapshot([entry({
            responseBody: JSON.stringify(deep),
        })], { maxDepth: Number.MAX_SAFE_INTEGER });
        expect(reasons(result)).toEqual({ body_depth_limit: 1 });
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

    it.each([
        [1, true], [2, false], [3, false],
    ])("enforces maxNodes at below/equal/above required work (%i)", (nodes, excluded) => {
        const result = normalizeCaptureSnapshot(
            [entry({ responseBody: JSON.stringify({ value: 1 }) })],
            { maxNodes: nodes },
        );
        expect(reasons(result)).toEqual(excluded ? { body_node_limit: 1 } : {});
    });

    it.each([
        [1, true], [2, false], [3, false],
    ])("enforces maxDepth at below/equal/above required depth (%i)", (depth, excluded) => {
        const result = normalizeCaptureSnapshot(
            [entry({ responseBody: JSON.stringify({ a: { b: 1 } }) })],
            { maxDepth: depth },
        );
        expect(reasons(result)).toEqual(excluded ? { body_depth_limit: 1 } : {});
    });

    it.each([
        [99, true], [100, false], [599, false], [600, true],
    ])("accepts only exact HTTP status range boundary %i", (statusCode, excluded) => {
        const result = normalizeCaptureSnapshot([entry({ statusCode })]);
        expect(reasons(result)).toEqual(excluded ? { invalid_status: 1 } : {});
    });

    it("does not consult host locale while ordering normalized evidence", () => {
        const original = String.prototype.localeCompare;
        String.prototype.localeCompare = () => {
            throw new Error("host locale must not be consulted");
        };
        try {
            const result = normalizeCaptureSnapshot([
                entry({ responseBody: JSON.stringify("ä") }),
                entry({ responseBody: JSON.stringify("z") }),
            ]);
            expect(result.observations.map(({ body }) => body)).toEqual(["z", "ä"]);
        }
        finally {
            String.prototype.localeCompare = original;
        }
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
