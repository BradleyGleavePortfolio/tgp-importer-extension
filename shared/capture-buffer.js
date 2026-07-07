// Bounded capture buffer for Layer 1 passive capture (see docs/AUTO_DISCOVERY.md
// §2 Layer 1 + §6 PR-C1). Extracted from shared/capture.js so the buffer is an
// independently testable unit with a minimal API, per the PR-C1 contract which
// names shared/capture-buffer.js explicitly.
//
// R75: zero banned type-assertions — every narrowing is a real guard.

const DEFAULT_CAPACITY = 500;

// Bounded circular buffer. On overflow the oldest entry is evicted. snapshot()
// returns entries oldest-first regardless of the internal write cursor.
class RingBuffer {
    constructor(capacity = DEFAULT_CAPACITY) {
        const isPositiveInt =
            typeof capacity === "number" && Number.isInteger(capacity) && capacity > 0;
        this.capacity = isPositiveInt ? capacity : DEFAULT_CAPACITY;
        this.entries = [];
        this.cursor = 0;
    }

    push(entry) {
        if (this.entries.length < this.capacity) {
            this.entries.push(entry);
            return;
        }
        this.entries[this.cursor] = entry;
        this.cursor = (this.cursor + 1) % this.capacity;
    }

    snapshot() {
        if (this.entries.length < this.capacity) {
            return this.entries.slice();
        }
        return this.entries.slice(this.cursor).concat(this.entries.slice(0, this.cursor));
    }

    clear() {
        this.entries = [];
        this.cursor = 0;
    }
}

// Factory kept as a named export because the C1 contract lists it explicitly.
function startRingBuffer(capacity = DEFAULT_CAPACITY) {
    return new RingBuffer(capacity);
}

export { RingBuffer, startRingBuffer, DEFAULT_CAPACITY };
