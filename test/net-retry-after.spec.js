import { describe, it, expect } from "vitest";
import { parseRetryAfterMs, readHeader, MAX_RETRY_AFTER_MS } from "../shared/net.js";

// Coverage of the Retry-After parsing half of the 429 story. The invariants that
// matter: both RFC 9110 forms are understood, garbage never becomes a delay (so
// the caller falls back to its own backoff rather than retrying instantly or
// waiting NaN ms), and NO input — however hostile — can produce a delay above
// MAX_RETRY_AFTER_MS. An unbounded honoured Retry-After would park an MV3 service
// worker for as long as the source felt like.

const NOW = Date.parse("2026-07-27T12:00:00Z");

describe("parseRetryAfterMs — delta-seconds form", () => {
    it("converts whole seconds to milliseconds", () => {
        expect(parseRetryAfterMs("5", NOW)).toBe(5000);
    });

    it("treats 0 as retry immediately, not as absent", () => {
        expect(parseRetryAfterMs("0", NOW)).toBe(0);
    });

    it("tolerates surrounding whitespace", () => {
        expect(parseRetryAfterMs("  7  ", NOW)).toBe(7000);
    });

    it("clamps an absurdly large delta to the bound", () => {
        expect(parseRetryAfterMs("86400", NOW)).toBe(MAX_RETRY_AFTER_MS);
    });

    it("clamps a value just over the bound", () => {
        expect(parseRetryAfterMs(String(MAX_RETRY_AFTER_MS / 1000 + 1), NOW)).toBe(MAX_RETRY_AFTER_MS);
    });

    it("accepts a value exactly at the bound", () => {
        expect(parseRetryAfterMs(String(MAX_RETRY_AFTER_MS / 1000), NOW)).toBe(MAX_RETRY_AFTER_MS);
    });
});

describe("parseRetryAfterMs — HTTP-date form", () => {
    it("returns the delta to a future date", () => {
        expect(parseRetryAfterMs("Mon, 27 Jul 2026 12:00:10 GMT", NOW)).toBe(10000);
    });

    it("returns 0 for a date already in the past rather than a negative delay", () => {
        expect(parseRetryAfterMs("Mon, 27 Jul 2026 11:59:00 GMT", NOW)).toBe(0);
    });

    it("clamps a far-future date to the bound", () => {
        expect(parseRetryAfterMs("Tue, 28 Jul 2026 12:00:00 GMT", NOW)).toBe(MAX_RETRY_AFTER_MS);
    });
});

describe("parseRetryAfterMs — rejects anything unparseable", () => {
    it.each([
        ["absent", undefined],
        ["null", null],
        ["a non-string number", 5],
        ["an empty string", ""],
        ["whitespace only", "   "],
        ["free text", "soon"],
        ["a negative delta", "-5"],
        ["a fractional delta", "1.5"],
        ["a garbage date", "Notaday, 99 Xxx 2026"],
    ])("returns null for %s", (_label, value) => {
        expect(parseRetryAfterMs(value, NOW)).toBeNull();
    });

    it("never returns NaN for any of the rejected forms", () => {
        for (const value of ["", "soon", "-5", "1.5", "NaN"]) {
            const parsed = parseRetryAfterMs(value, NOW);
            expect(parsed === null || Number.isFinite(parsed)).toBe(true);
        }
    });
});

describe("readHeader — tolerant Response header access", () => {
    it("reads a header from a Headers-like object", () => {
        const res = { headers: new Headers({ "Retry-After": "3" }) };
        expect(readHeader(res, "Retry-After")).toBe("3");
    });

    it("is case-insensitive via the underlying Headers implementation", () => {
        const res = { headers: new Headers({ "retry-after": "3" }) };
        expect(readHeader(res, "Retry-After")).toBe("3");
    });

    it("returns null when the header is absent", () => {
        const res = { headers: new Headers({}) };
        expect(readHeader(res, "Retry-After")).toBeNull();
    });

    it.each([
        ["no headers property", {}],
        ["a plain object with no get()", { headers: { "Retry-After": "3" } }],
        ["a null response", null],
        ["a non-object response", "nope"],
        ["null headers", { headers: null }],
    ])("returns null for %s rather than throwing", (_label, res) => {
        expect(readHeader(res, "Retry-After")).toBeNull();
    });

    it("returns null when get() yields a non-string", () => {
        expect(readHeader({ headers: { get: () => 3 } }, "Retry-After")).toBeNull();
    });

    it("composes with the parser so a bad header degrades to null, not a throw", () => {
        expect(parseRetryAfterMs(readHeader({}, "Retry-After"), NOW)).toBeNull();
    });
});
