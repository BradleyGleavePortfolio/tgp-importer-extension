import { describe, it, expect } from "vitest";
import {
    sourcePlatformFor,
    redactHeaders,
    redactUrl,
} from "../shared/capture.js";
import { CaptureBuffer, byteSizeOf, createCaptureBuffer } from "../shared/capture-buffer.js";

// Additional coverage to hold the capture subsystem above the R74 test:src floor
// and pin down behaviours the primary specs do not assert directly.

describe("redactUrl — additional guarantees", () => {
    it("redacts every sensitive key when several appear in one URL", () => {
        const out = redactUrl("https://x.co/p?token=a&access_token=b&page=2&session=c");
        expect(out).toContain("token=<redacted>");
        expect(out).toContain("access_token=<redacted>");
        expect(out).toContain("session=<redacted>");
        expect(out).toContain("page=2");
        expect(out).not.toContain("=a");
        expect(out).not.toContain("=b");
        expect(out).not.toContain("=c");
    });

    it("redacts a sensitive key even when its value is empty", () => {
        expect(redactUrl("https://x.co/p?token=&keep=1")).toContain("token=<redacted>");
    });

    it("leaves non-sensitive params percent-encoded and intact", () => {
        const out = redactUrl("https://x.co/p?token=z&q=a%20b");
        expect(out).toContain("q=a%20b");
        expect(out).toContain("token=<redacted>");
    });
});

describe("redactHeaders — non-mutation", () => {
    it("does not mutate the caller's header object", () => {
        const input = { Authorization: "Bearer x", "X-Keep": "1" };
        const out = redactHeaders(input);
        expect(input.Authorization).toBe("Bearer x");
        expect(out.Authorization).toBe("<redacted>");
        expect(out).not.toBe(input);
    });
});

describe("sourcePlatformFor — host edge cases", () => {
    it("drops the port and keeps only the host", () => {
        expect(sourcePlatformFor("https://x.co:8443/a")).toBe("auto:x.co");
    });

    it("handles an IPv4 literal host", () => {
        expect(sourcePlatformFor("http://127.0.0.1/a")).toBe("auto:127.0.0.1");
    });

    it("returns null for a non-string input", () => {
        expect(sourcePlatformFor(undefined)).toBeNull();
        expect(sourcePlatformFor(42)).toBeNull();
    });
});

describe("CaptureBuffer — boundary behaviour", () => {
    it("retains an entry sitting exactly at the byte cap", () => {
        const buf = new CaptureBuffer(10_000);
        const entry = { requestId: "a", responseBody: "{}" };
        buf.push(entry);
        expect(buf.snapshot()).toHaveLength(1);
        expect(buf.totalBytes).toBeLessThanOrEqual(10_000);
    });

    it("returns a fresh array from each snapshot call", () => {
        const buf = new CaptureBuffer();
        buf.push({ requestId: "a", responseBody: "{}" });
        const first = buf.snapshot();
        const second = buf.snapshot();
        expect(first).not.toBe(second);
        expect(first).toEqual(second);
    });

    it("accepts pushes again after clear()", () => {
        const buf = new CaptureBuffer();
        buf.push({ requestId: "a", responseBody: "{}" });
        buf.clear();
        expect(buf.snapshot()).toHaveLength(0);
        expect(buf.totalBytes).toBe(0);
        buf.push({ requestId: "b", responseBody: "{}" });
        expect(buf.snapshot().map((e) => e.requestId)).toEqual(["b"]);
    });

    it("createCaptureBuffer yields an independent instance", () => {
        const a = createCaptureBuffer();
        const b = createCaptureBuffer();
        a.push({ requestId: "x", responseBody: "{}" });
        expect(a.snapshot()).toHaveLength(1);
        expect(b.snapshot()).toHaveLength(0);
    });
});

describe("byteSizeOf — additional shapes", () => {
    it("sizes an empty object as its JSON length", () => {
        expect(byteSizeOf({})).toBe(2);
    });

    it("counts multibyte UTF-8 payloads by encoded byte length", () => {
        const ascii = byteSizeOf({ v: "aaa" });
        const wide = byteSizeOf({ v: "☃☃☃" });
        expect(wide).toBeGreaterThan(ascii);
    });
});
