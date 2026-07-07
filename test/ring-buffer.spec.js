import { describe, it, expect } from "vitest";
import { RingBuffer, startRingBuffer } from "../shared/capture-buffer.js";
import { sourcePlatformFor } from "../shared/capture.js";

describe("RingBuffer", () => {
    it("stores entries below capacity in insertion order", () => {
        const buf = new RingBuffer(3);
        buf.push("a");
        buf.push("b");
        expect(buf.snapshot()).toEqual(["a", "b"]);
    });

    it("fills exactly to capacity without eviction", () => {
        const buf = new RingBuffer(3);
        buf.push("a");
        buf.push("b");
        buf.push("c");
        expect(buf.snapshot()).toEqual(["a", "b", "c"]);
    });

    it("evicts the oldest entry on overflow", () => {
        const buf = new RingBuffer(3);
        ["a", "b", "c", "d"].forEach((e) => buf.push(e));
        expect(buf.snapshot()).toEqual(["b", "c", "d"]);
    });

    it("keeps oldest-first order after wrapping multiple times", () => {
        const buf = new RingBuffer(3);
        ["a", "b", "c", "d", "e", "f", "g"].forEach((e) => buf.push(e));
        expect(buf.snapshot()).toEqual(["e", "f", "g"]);
    });

    it("clear() empties the buffer and resets the cursor", () => {
        const buf = new RingBuffer(2);
        buf.push("a");
        buf.push("b");
        buf.push("c");
        buf.clear();
        expect(buf.snapshot()).toEqual([]);
        buf.push("x");
        expect(buf.snapshot()).toEqual(["x"]);
    });

    it("defaults to capacity 500 when given no argument", () => {
        expect(new RingBuffer().capacity).toBe(500);
    });

    it("falls back to 500 for zero, negative, or non-integer capacity", () => {
        expect(new RingBuffer(0).capacity).toBe(500);
        expect(new RingBuffer(-4).capacity).toBe(500);
        expect(new RingBuffer(2.5).capacity).toBe(500);
        expect(new RingBuffer("nope").capacity).toBe(500);
    });

    it("snapshot() returns a copy, not the internal array", () => {
        const buf = new RingBuffer(3);
        buf.push("a");
        const snap = buf.snapshot();
        snap.push("mutated");
        expect(buf.snapshot()).toEqual(["a"]);
    });
});

describe("startRingBuffer", () => {
    it("returns a RingBuffer with the requested capacity", () => {
        const buf = startRingBuffer(7);
        expect(buf).toBeInstanceOf(RingBuffer);
        expect(buf.capacity).toBe(7);
    });

    it("defaults to 500 with no argument", () => {
        expect(startRingBuffer().capacity).toBe(500);
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
