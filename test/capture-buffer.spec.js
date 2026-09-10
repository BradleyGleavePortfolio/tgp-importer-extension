import { describe, expect, it } from "vitest";
import {
  CaptureBuffer,
  createCaptureBuffer,
  byteSizeOf,
  DEFAULT_MAX_BYTES,
  MAX_CAPTURE_BYTES,
} from "../shared/capture-buffer.js";
import { sourcePlatformFor } from "../shared/capture.js";

function kilobyteEntry(tag) {
  return { tag, body: "x".repeat(1024) };
}

function tags(buffer) {
  return buffer.snapshot().map((entry) => entry.tag);
}

describe("CaptureBuffer byte ceiling", () => {
  it("defaults to a five-megabyte cap", () => {
    expect(DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(new CaptureBuffer().maxBytes).toBe(DEFAULT_MAX_BYTES);
  });

  it("enforces a non-overridable absolute capacity ceiling", () => {
    expect(new CaptureBuffer(MAX_CAPTURE_BYTES - 1).maxBytes).toBe(
      MAX_CAPTURE_BYTES - 1,
    );
    expect(new CaptureBuffer(MAX_CAPTURE_BYTES).maxBytes).toBe(
      MAX_CAPTURE_BYTES,
    );
    expect(new CaptureBuffer(MAX_CAPTURE_BYTES + 1).maxBytes).toBe(
      MAX_CAPTURE_BYTES,
    );
    expect(new CaptureBuffer(Number.MAX_SAFE_INTEGER).maxBytes).toBe(
      MAX_CAPTURE_BYTES,
    );
  });

  it.each([0, -1, Number.NaN, Infinity, -Infinity])(
    "uses the default for invalid numeric capacity %s",
    (capacity) => {
      expect(new CaptureBuffer(capacity).maxBytes).toBe(DEFAULT_MAX_BYTES);
    },
  );

  it("uses the default for a non-numeric capacity", () => {
    // @ts-expect-error -- verifies validation at the JavaScript API boundary.
    expect(new CaptureBuffer("large").maxBytes).toBe(DEFAULT_MAX_BYTES);
  });

  it("accounts for the exact UTF-8 JSON size of stored entries", () => {
    const buffer = new CaptureBuffer(1024);
    const entries = [{ plain: "abc" }, { unicode: "€😀" }, [true, null, 3]];
    for (const entry of entries) buffer.push(entry);
    expect(buffer.totalBytes).toBe(
      entries.reduce((total, entry) => total + byteSizeOf(entry), 0),
    );
  });

  it("keeps the running byte total within the cap under sustained writes", () => {
    const cap = 128 * 1024;
    const buffer = new CaptureBuffer(cap);
    for (let index = 0; index < 1000; index += 1) {
      buffer.push(kilobyteEntry(`entry-${index}`));
      expect(buffer.totalBytes).toBeLessThanOrEqual(cap);
    }
    expect(buffer.snapshot().length).toBeGreaterThan(0);
  });

  it("fills an exact byte boundary without eviction", () => {
    const first = { tag: "a", value: "€" };
    const second = { tag: "b", value: "x" };
    const cap = byteSizeOf(first) + byteSizeOf(second);
    const buffer = new CaptureBuffer(cap);
    buffer.push(first);
    buffer.push(second);
    expect(tags(buffer)).toEqual(["a", "b"]);
    expect(buffer.totalBytes).toBe(cap);
  });

  it("never admits a single entry one byte above the configured cap", () => {
    const entry = { tag: "large", body: "abcdef" };
    const buffer = new CaptureBuffer(byteSizeOf(entry) - 1);
    buffer.push(entry);
    expect(buffer.snapshot()).toEqual([]);
    expect(buffer.totalBytes).toBe(0);
  });

  it("does not evict existing entries for an oversized new entry", () => {
    const existing = { tag: "existing" };
    const buffer = new CaptureBuffer(byteSizeOf(existing) + 2);
    buffer.push(existing);
    buffer.push({ tag: "oversized", body: "x".repeat(1000) });
    expect(tags(buffer)).toEqual(["existing"]);
    expect(buffer.totalBytes).toBe(byteSizeOf(existing));
  });
});

describe("CaptureBuffer oldest-first eviction", () => {
  it("evicts the oldest entries until the total is within the cap", () => {
    const size = byteSizeOf(kilobyteEntry("x"));
    const buffer = new CaptureBuffer(size * 3 + 8);
    buffer.push(kilobyteEntry("a"));
    buffer.push(kilobyteEntry("b"));
    buffer.push(kilobyteEntry("c"));
    buffer.push(kilobyteEntry("d"));
    expect(tags(buffer)).toEqual(["b", "c", "d"]);
    expect(buffer.totalBytes).toBeLessThanOrEqual(buffer.maxBytes);
  });

  it("can evict multiple old entries for one admissible new entry", () => {
    const small = { tag: "small", body: "x".repeat(20) };
    const large = { tag: "large", body: "y".repeat(80) };
    const buffer = new CaptureBuffer(byteSizeOf(large));
    buffer.push(small);
    buffer.push({ ...small, tag: "other" });
    buffer.push(large);
    expect(tags(buffer)).toEqual(["large"]);
    expect(buffer.totalBytes).toBe(byteSizeOf(large));
  });

  it("preserves insertion order for entries that survive eviction", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      tag: `e${index}`,
      value: index,
    }));
    const cap = entries
      .slice(4)
      .reduce((total, entry) => total + byteSizeOf(entry), 0);
    const buffer = new CaptureBuffer(cap);
    for (const entry of entries) buffer.push(entry);
    expect(tags(buffer)).toEqual(["e4", "e5", "e6", "e7"]);
  });

  it("starts fresh after clear", () => {
    const buffer = new CaptureBuffer(1024);
    buffer.push({ tag: "old" });
    buffer.clear();
    buffer.push({ tag: "new" });
    expect(tags(buffer)).toEqual(["new"]);
    expect(buffer.totalBytes).toBe(byteSizeOf({ tag: "new" }));
  });

  it("makes repeated clear operations idempotent", () => {
    const buffer = new CaptureBuffer(1024);
    buffer.push({ tag: "old" });
    buffer.clear();
    buffer.clear();
    expect(buffer.snapshot()).toEqual([]);
    expect(buffer.totalBytes).toBe(0);
  });
});

describe("CaptureBuffer immutable snapshots", () => {
  it("captures values at push time rather than retaining input references", () => {
    const input = {
      tag: "entry",
      nested: { name: "before" },
      list: [{ enabled: true }],
    };
    const buffer = new CaptureBuffer(1024);
    buffer.push(input);
    input.tag = "changed";
    input.nested.name = "after";
    input.list[0].enabled = false;
    input.list.push({ enabled: false });
    expect(buffer.snapshot()).toEqual([
      {
        tag: "entry",
        nested: { name: "before" },
        list: [{ enabled: true }],
      },
    ]);
  });

  it("does not expose internal entries through snapshot results", () => {
    const buffer = new CaptureBuffer(1024);
    buffer.push({ nested: { count: 1 }, list: [1, 2] });
    const first = buffer.snapshot();
    first[0].nested.count = 99;
    first[0].list.push(3);
    first.push({ injected: true });
    expect(buffer.snapshot()).toEqual([{ nested: { count: 1 }, list: [1, 2] }]);
  });

  it("returns independent object graphs for repeated snapshots", () => {
    const buffer = new CaptureBuffer(1024);
    buffer.push({ nested: { value: "stable" } });
    const first = buffer.snapshot();
    const second = buffer.snapshot();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0].nested).not.toBe(second[0].nested);
  });

  it("copies null-prototype objects without changing their data", () => {
    const input = Object.create(null);
    input.tag = "safe";
    input.nested = Object.assign(Object.create(null), { count: 2 });
    const buffer = new CaptureBuffer(1024);
    buffer.push(input);
    expect(buffer.snapshot()).toEqual([{ tag: "safe", nested: { count: 2 } }]);
  });

  it("preserves sparse-array JSON semantics without inherited values", () => {
    const input = [];
    input.length = 3;
    input[1] = "middle";
    const buffer = new CaptureBuffer(1024);
    buffer.push(input);
    expect(buffer.snapshot()).toEqual([[null, "middle", null]]);
  });
});

describe("CaptureBuffer hostile input handling", () => {
  it("rejects cyclic input without throwing or changing buffer state", () => {
    const cyclic = { tag: "cycle" };
    cyclic.self = cyclic;
    const buffer = new CaptureBuffer(1024);
    expect(() => buffer.push(cyclic)).not.toThrow();
    expect(buffer.snapshot()).toEqual([]);
    expect(buffer.totalBytes).toBe(0);
  });

  it("does not invoke object getters", () => {
    let calls = 0;
    const hostile = {
      tag: "getter",
      get secret() {
        calls += 1;
        throw new Error("must not execute");
      },
    };
    const buffer = new CaptureBuffer(1024);
    expect(() => buffer.push(hostile)).not.toThrow();
    expect(calls).toBe(0);
    expect(buffer.snapshot()).toEqual([]);
  });

  it("does not invoke array getters", () => {
    let calls = 0;
    const hostile = [];
    Object.defineProperty(hostile, "0", {
      enumerable: true,
      get() {
        calls += 1;
        return "private";
      },
    });
    hostile.length = 1;
    const buffer = new CaptureBuffer(1024);
    buffer.push(hostile);
    expect(calls).toBe(0);
    expect(buffer.snapshot()).toEqual([]);
  });

  it("does not invoke toJSON hooks", () => {
    let calls = 0;
    const hostile = {
      value: "private",
      toJSON() {
        calls += 1;
        throw new Error("must not execute");
      },
    };
    const buffer = new CaptureBuffer(1024);
    buffer.push(hostile);
    expect(calls).toBe(0);
    expect(buffer.snapshot()).toEqual([]);
  });

  it("contains proxy trap failures", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile trap");
        },
        ownKeys() {
          throw new Error("hostile trap");
        },
      },
    );
    const buffer = new CaptureBuffer(1024);
    expect(() => buffer.push(hostile)).not.toThrow();
    expect(buffer.snapshot()).toEqual([]);
  });

  it.each([undefined, 1n, Symbol("private"), () => "private", NaN, Infinity])(
    "rejects non-JSON value %s without throwing",
    (value) => {
      const buffer = new CaptureBuffer(1024);
      expect(() => buffer.push(value)).not.toThrow();
      expect(buffer.snapshot()).toEqual([]);
      expect(buffer.totalBytes).toBe(0);
    },
  );

  it("rejects unsupported nested values atomically", () => {
    const buffer = new CaptureBuffer(1024);
    buffer.push({ tag: "good" });
    buffer.push({ tag: "bad", nested: { value: 1n } });
    expect(tags(buffer)).toEqual(["good"]);
    expect(buffer.totalBytes).toBe(byteSizeOf({ tag: "good" }));
  });

  it("rejects custom prototypes instead of executing their behavior", () => {
    class Hostile {
      constructor() {
        this.value = "private";
      }
    }
    const buffer = new CaptureBuffer(1024);
    expect(() => buffer.push(new Hostile())).not.toThrow();
    expect(buffer.snapshot()).toEqual([]);
  });

  it("rejects deeply nested objects before recursive work can exhaust the stack", () => {
    const root = {};
    let cursor = root;
    for (let index = 0; index < 20_000; index += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    const buffer = new CaptureBuffer(1024);
    expect(() => buffer.push(root)).not.toThrow();
    expect(buffer.snapshot()).toEqual([]);
  });

  it("rejects huge arrays before visiting their elements", () => {
    let calls = 0;
    const value = new Array(10_001);
    Object.defineProperty(value, "0", {
      enumerable: true,
      get() {
        calls += 1;
        return "private";
      },
    });
    const buffer = new CaptureBuffer(1024);
    expect(() => buffer.push(value)).not.toThrow();
    expect(calls).toBe(0);
    expect(buffer.snapshot()).toEqual([]);
  });

  it("rejects a graph that exceeds the node-work ceiling", () => {
    const value = Array.from({ length: 10_000 }, () => [null, null]);
    const buffer = new CaptureBuffer(1024);
    expect(() => buffer.push(value)).not.toThrow();
    expect(buffer.snapshot()).toEqual([]);
  });

  it("rejects strings beyond the absolute byte ceiling", () => {
    const buffer = new CaptureBuffer(MAX_CAPTURE_BYTES);
    const value = "x".repeat(MAX_CAPTURE_BYTES + 1);
    expect(() => buffer.push(value)).not.toThrow();
    expect(buffer.snapshot()).toEqual([]);
  });
});

describe("byteSizeOf", () => {
  it.each([
    null,
    true,
    false,
    0,
    -12.5,
    "",
    "plain",
    "€",
    [1, "two", null],
    { a: 1, b: [true] },
  ])("matches TextEncoder(JSON.stringify(value)) for %j", (value) => {
    expect(byteSizeOf(value)).toBe(
      new TextEncoder().encode(JSON.stringify(value)).length,
    );
  });

  it("is stable across later mutation", () => {
    const input = { value: "before" };
    const before = byteSizeOf(input);
    input.value = "a much longer value after mutation";
    expect(before).toBe(new TextEncoder().encode('{"value":"before"}').length);
    expect(byteSizeOf(input)).toBeGreaterThan(before);
  });

  it.each([undefined, 1n, Symbol("private"), () => "private", NaN, Infinity])(
    "returns zero for unsupported value %s",
    (value) => {
      expect(byteSizeOf(value)).toBe(0);
    },
  );

  it("returns zero for cyclic input", () => {
    const value = {};
    value.self = value;
    expect(byteSizeOf(value)).toBe(0);
  });

  it("returns zero without invoking an accessor", () => {
    let calls = 0;
    const value = {};
    Object.defineProperty(value, "secret", {
      enumerable: true,
      get() {
        calls += 1;
        return "private";
      },
    });
    expect(byteSizeOf(value)).toBe(0);
    expect(calls).toBe(0);
  });
});

describe("createCaptureBuffer", () => {
  it("returns a CaptureBuffer with the requested cap", () => {
    const buffer = createCaptureBuffer(4096);
    expect(buffer).toBeInstanceOf(CaptureBuffer);
    expect(buffer.maxBytes).toBe(4096);
  });

  it("defaults to the five-megabyte cap", () => {
    expect(createCaptureBuffer().maxBytes).toBe(DEFAULT_MAX_BYTES);
  });

  it("applies the absolute ceiling through the factory", () => {
    expect(createCaptureBuffer(MAX_CAPTURE_BYTES * 2).maxBytes).toBe(
      MAX_CAPTURE_BYTES,
    );
  });
});

describe("sourcePlatformFor", () => {
  it("returns auto:<hostname> for a valid HTTPS URL", () => {
    expect(sourcePlatformFor("https://app.truecoach.co/clients/42")).toBe(
      "auto:app.truecoach.co",
    );
  });

  it("uses the hostname only, ignoring port and path", () => {
    expect(sourcePlatformFor("https://api.example.com:8443/v1/x?y=1")).toBe(
      "auto:api.example.com",
    );
  });

  it("returns null for malformed, empty, or non-string input", () => {
    expect(sourcePlatformFor("not a url")).toBeNull();
    expect(sourcePlatformFor("")).toBeNull();
    expect(sourcePlatformFor(null)).toBeNull();
    expect(sourcePlatformFor(undefined)).toBeNull();
    expect(sourcePlatformFor(42)).toBeNull();
  });
});
