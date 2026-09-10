import { describe, it, expect } from "vitest";
import {
    CaptureBuffer,
    createCaptureBuffer,
    byteSizeOf,
    DEFAULT_MAX_BYTES,
    MAX_CAPTURE_BYTES,
} from "../shared/capture-buffer.js";
import { sourcePlatformFor } from "../shared/capture.js";

// A payload whose serialized size is ~1 KB, for byte-accounting tests.
function kilobyteEntry(tag) {
    return { tag, body: "x".repeat(1024) };
}

describe("CaptureBuffer byte accounting", () => {
    it("defaults to a 5 MB cap", () => {
        expect(new CaptureBuffer().maxBytes).toBe(5 * 1024 * 1024);
        expect(DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024);
    });

    it("enforces an absolute non-overridable capacity ceiling", () => {
        expect(new CaptureBuffer(MAX_CAPTURE_BYTES - 1).maxBytes).toBe(MAX_CAPTURE_BYTES - 1);
        expect(new CaptureBuffer(MAX_CAPTURE_BYTES).maxBytes).toBe(MAX_CAPTURE_BYTES);
        expect(new CaptureBuffer(MAX_CAPTURE_BYTES + 1).maxBytes).toBe(MAX_CAPTURE_BYTES);
        expect(new CaptureBuffer(Number.MAX_SAFE_INTEGER).maxBytes).toBe(MAX_CAPTURE_BYTES);
    });

    it("keeps the running byte total under the cap when 6 MB is added in 1 KB chunks", () => {
        const cap = 5 * 1024 * 1024;
        const buf = new CaptureBuffer(cap);
        const chunkBytes = byteSizeOf(kilobyteEntry("c"));
        const chunks = Math.ceil((6 * 1024 * 1024) / chunkBytes);
        for (let i = 0; i < chunks; i += 1) {
            buf.push(kilobyteEntry(`c${i}`));
        }
        expect(buf.totalBytes).toBeLessThanOrEqual(cap);
        // A representative slice of the newest data survives; nothing is over cap.
        expect(buf.snapshot().length).toBeGreaterThan(0);
    });

    it("evicts oldest-first until back under the cap", () => {
        // Cap sized to hold ~3 one-kilobyte entries.
        const cap = byteSizeOf(kilobyteEntry("x")) * 3 + 8;
        const buf = new CaptureBuffer(cap);
        buf.push(kilobyteEntry("a"));
        buf.push(kilobyteEntry("b"));
        buf.push(kilobyteEntry("c"));
        buf.push(kilobyteEntry("d"));
        const tags = buf.snapshot().map((e) => e.tag);
        expect(tags).not.toContain("a");
        expect(tags[tags.length - 1]).toBe("d");
        expect(buf.totalBytes).toBeLessThanOrEqual(cap);
    });

    it("stores small entries without eviction while under the cap", () => {
        const buf = new CaptureBuffer(1024 * 1024);
        buf.push({ n: 1 });
        buf.push({ n: 2 });
        expect(buf.snapshot()).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it("drops a single entry that alone exceeds the cap", () => {
        const buf = new CaptureBuffer(64);
        buf.push({ body: "y".repeat(10_000) });
        expect(buf.snapshot()).toEqual([]);
        expect(buf.totalBytes).toBe(0);
    });

    it("clear() empties the buffer and resets the byte total", () => {
        const buf = new CaptureBuffer(1024);
        buf.push({ n: 1 });
        buf.clear();
        expect(buf.snapshot()).toEqual([]);
        expect(buf.totalBytes).toBe(0);
    });

    it("snapshot() returns a copy, not the internal array", () => {
        const buf = new CaptureBuffer(1024);
        buf.push({ n: 1 });
        const snap = buf.snapshot();
        snap.push("mutated");
        expect(buf.snapshot()).toEqual([{ n: 1 }]);
    });

    it("falls back to the default cap for zero, negative, or non-numeric maxBytes", () => {
        expect(new CaptureBuffer(0).maxBytes).toBe(DEFAULT_MAX_BYTES);
        expect(new CaptureBuffer(-10).maxBytes).toBe(DEFAULT_MAX_BYTES);
        expect(new CaptureBuffer("big").maxBytes).toBe(DEFAULT_MAX_BYTES);
        expect(new CaptureBuffer(Number.NaN).maxBytes).toBe(DEFAULT_MAX_BYTES);
        expect(new CaptureBuffer(Infinity).maxBytes).toBe(DEFAULT_MAX_BYTES);
    });

    it("preserves object references, not copies", () => {
        const buf = new CaptureBuffer(1024);
        const obj = { k: 1 };
        buf.push(obj);
        expect(buf.snapshot()[0]).toBe(obj);
    });
});

describe("byteSizeOf", () => {
    it("measures UTF-8 serialized length", () => {
        expect(byteSizeOf({ a: 1 })).toBe(new TextEncoder().encode('{"a":1}').length);
    });

    it("returns 0 for a value that cannot be serialized", () => {
        const cyclic = {};
        cyclic.self = cyclic;
        expect(byteSizeOf(cyclic)).toBe(0);
    });

    it("counts multi-byte characters by their encoded byte length", () => {
        expect(byteSizeOf("€")).toBe(new TextEncoder().encode('"€"').length);
    });
});

describe("createCaptureBuffer", () => {
    it("returns a CaptureBuffer with the requested cap", () => {
        const buf = createCaptureBuffer(4096);
        expect(buf).toBeInstanceOf(CaptureBuffer);
        expect(buf.maxBytes).toBe(4096);
    });

    it("defaults to the 5 MB cap with no argument", () => {
        expect(createCaptureBuffer().maxBytes).toBe(DEFAULT_MAX_BYTES);
    });
});

describe("sourcePlatformFor", () => {
    it("returns auto:<hostname> for a valid https URL", () => {
        expect(sourcePlatformFor("https://app.truecoach.co/clients/42")).toBe(
            "auto:app.truecoach.co",
        );
    });

    it("uses the hostname only, ignoring port and path", () => {
        expect(sourcePlatformFor("https://api.example.com:8443/v1/x?y=1")).toBe(
            "auto:api.example.com",
        );
    });

    it("returns null for a malformed URL", () => {
        expect(sourcePlatformFor("not a url")).toBeNull();
    });

    it("returns null for empty or non-string input", () => {
        expect(sourcePlatformFor("")).toBeNull();
        expect(sourcePlatformFor(null)).toBeNull();
        expect(sourcePlatformFor(undefined)).toBeNull();
        expect(sourcePlatformFor(42)).toBeNull();
    });
});
