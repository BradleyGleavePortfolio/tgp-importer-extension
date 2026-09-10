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

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024, MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function fitsCheapBound(entry, limit) {
    const pending = [entry], seen = new WeakSet(); let bytes = 0, nodes = 0;
    const stringBytes = (text) => { let size = 2; for (const char of text) {
        const code = char.codePointAt(0); size += code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code) ? 2
            : code < 32 || code >= 0xd800 && code <= 0xdfff ? 6 : code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
        return size; };
    while (pending.length) { const value = pending.pop(); if (++nodes > 20000) return false;
        if (typeof value === "string") bytes += stringBytes(value);
        else if (value && typeof value === "object") {
            if (seen.has(value)) return false; seen.add(value); const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
            if (proto !== (array ? Array.prototype : Object.prototype) && proto !== null) return false;
            const keys = array ? null : Object.keys(value);
            if (array) {
                if (value.length > 20000) return false; bytes += 2 + Math.max(0, value.length - 1);
                for (let index = 0; index < value.length; index++)
                    if (Object.hasOwn(value, index)) pending.push(value[index]); else bytes += 4;
            } else {
                bytes += 2 + Math.max(0, keys.length - 1);
                for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key);
                    if (!descriptor || !("value" in descriptor) || key === "toJSON") return false;
                    bytes += stringBytes(key) + 1; pending.push(descriptor.value); } }
        } else bytes += 8;
        if (bytes > limit) return false; } return true;
}

function byteSizeOf(entry) {
    try { const json = JSON.stringify(entry);
        return typeof json === "string" ? new TextEncoder().encode(json).length : null;
    } catch { return null; }
}
function freezeTree(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value))
        Object.freeze(value), Object.values(value).forEach(freezeTree);
    return value;
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
        if (!fitsCheapBound(entry, this.maxBytes)) return;
        const size = byteSizeOf(entry);
        if (size === null || size > this.maxBytes) return;
        let held; try { held = freezeTree(JSON.parse(JSON.stringify(entry))); } catch { return; }
        this.entries.push({ entry: held, size });
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
