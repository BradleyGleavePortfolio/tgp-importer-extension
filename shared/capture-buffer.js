// Entries are stored as serialized immutable snapshots. This makes byte
// accounting exact and prevents later mutation through either the input object
// or an earlier snapshot. Overflow evicts the oldest entries first.
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;
const MAX_COLLECTION = 10_000;
const encoder = new TextEncoder();

function copyJson(value, state, depth = 0) {
  if (++state.nodes > MAX_NODES || depth > MAX_DEPTH)
    throw new Error("capture_snapshot_limit");
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (typeof value === "string") {
    if (
      value.length > MAX_CAPTURE_BYTES ||
      encoder.encode(value).length > MAX_CAPTURE_BYTES
    )
      throw new Error("capture_snapshot_limit");
    return value;
  }
  if (typeof value !== "object") throw new Error("capture_non_json_value");
  if (state.active.has(value)) throw new Error("capture_cycle");
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION)
        throw new Error("capture_snapshot_limit");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[index];
        if (!descriptor) return null;
        if (!Object.hasOwn(descriptor, "value"))
          throw new Error("capture_accessor");
        return copyJson(descriptor.value, state, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("capture_non_json_value");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter(
      (key) => descriptors[key].enumerable,
    );
    if (keys.length > MAX_COLLECTION) throw new Error("capture_snapshot_limit");
    const result = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, "value"))
        throw new Error("capture_accessor");
      result[key] = copyJson(descriptor.value, state, depth + 1);
    }
    return result;
  } finally {
    state.active.delete(value);
  }
}

function encodedSnapshot(entry) {
  try {
    const json = JSON.stringify(
      copyJson(entry, { active: new WeakSet(), nodes: 0 }),
    );
    if (typeof json !== "string") return null;
    const size = encoder.encode(json).length;
    return size <= MAX_CAPTURE_BYTES ? { json, size } : null;
  } catch {
    return null;
  }
}

function byteSizeOf(entry) {
  return encodedSnapshot(entry)?.size ?? 0;
}

class CaptureBuffer {
  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    const valid =
      typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0;
    this.maxBytes = valid
      ? Math.min(maxBytes, MAX_CAPTURE_BYTES)
      : DEFAULT_MAX_BYTES;
    this.entries = [];
    this.totalBytes = 0;
  }

  push(entry) {
    const held = encodedSnapshot(entry);
    if (!held || held.size > this.maxBytes) return;
    this.entries.push(held);
    this.totalBytes += held.size;
    while (this.totalBytes > this.maxBytes) {
      const oldest = this.entries.shift();
      this.totalBytes -= oldest.size;
    }
  }

  snapshot() {
    return this.entries.map(({ json }) => JSON.parse(json));
  }

  clear() {
    this.entries = [];
    this.totalBytes = 0;
  }
}

function createCaptureBuffer(maxBytes = DEFAULT_MAX_BYTES) {
  return new CaptureBuffer(maxBytes);
}

export {
  CaptureBuffer,
  createCaptureBuffer,
  byteSizeOf,
  DEFAULT_MAX_BYTES,
  MAX_CAPTURE_BYTES,
};
