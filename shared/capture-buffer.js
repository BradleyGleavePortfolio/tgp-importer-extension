// Bounded capture buffer for Layer 1 passive capture (see docs/AUTO_DISCOVERY.md
// §2 Layer 1 + §6 PR-C1). Extracted from shared/capture.js so the buffer is an
// independently testable unit with a minimal API, per the PR-C1 contract which
// names shared/capture-buffer.js explicitly.
//
// The buffer is byte-accounted, NOT entry-counted: the spec caps capture at
// 5 MB (LRU by capture time), because one large JSON response can dwarf 500
// small ones. Each entry's serialized byte size is tracked; on overflow the
// oldest entries are evicted until the running total is back under the cap.
//
// R75: zero banned type-assertions — every narrowing is a real guard.

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

// Serialized UTF-8 byte size of an entry. TextEncoder is available in both the
// MV3 service worker and the vitest (Node) test runner. Unserializable values
// contribute 0 bytes rather than throwing.
function byteSizeOf(entry) {
    let json;
    try {
        json = JSON.stringify(entry);
    }
    catch {
        return 0;
    }
    if (typeof json !== "string") {
        return 0;
    }
    return new TextEncoder().encode(json).length;
}

// Byte-bounded LRU buffer. push() appends and then evicts oldest-first until the
// cumulative byte total is within maxBytes. snapshot() returns entries
// oldest-first. A single entry larger than the whole cap is dropped (the memory
// bound is a hard invariant).
class CaptureBuffer {
    constructor(maxBytes = DEFAULT_MAX_BYTES) {
        const valid = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0;
        this.maxBytes = valid ? Math.min(maxBytes, MAX_CAPTURE_BYTES) : DEFAULT_MAX_BYTES;
        this.entries = [];
        this.totalBytes = 0;
    }

    push(entry) {
        const size = byteSizeOf(entry);
        this.entries.push({ entry, size });
        this.totalBytes += size;
        while (this.totalBytes > this.maxBytes && this.entries.length > 0) {
            const oldest = this.entries.shift();
            this.totalBytes -= oldest.size;
        }
    }

    snapshot() {
        return this.entries.map((held) => held.entry);
    }

    clear() {
        this.entries = [];
        this.totalBytes = 0;
    }
}

// Factory kept as a named export because the C1 contract lists it explicitly.
function createCaptureBuffer(maxBytes = DEFAULT_MAX_BYTES) {
    return new CaptureBuffer(maxBytes);
}

export { CaptureBuffer, createCaptureBuffer, byteSizeOf, DEFAULT_MAX_BYTES, MAX_CAPTURE_BYTES };
