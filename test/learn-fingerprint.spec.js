import { describe, expect, it } from "vitest";
import { buildStructureDigest } from "../shared/learn/digest.js";
import {
  collectionItemShape,
  fingerprintMaterial,
  itemShapeSignature,
  structureFingerprint,
} from "../shared/learn/fingerprint.js";
import { shapeSignature } from "../shared/blueprint/shapes.js";
import {
  loadFingerprintVectors,
  loadParityFixture,
} from "./helpers/learn-fixtures.js";

// L02 semantics on the extension side (L0 D-L0-5): the fingerprint is
// order-independent, ignores ids and values, changes when a collection
// template or its item keys change, and is pinned by canonical vectors the
// backend must reproduce byte for byte.

const VECTORS = loadFingerprintVectors().vectors;
const byName = (name) => VECTORS.find((vector) => vector.name === name);

describe("canonical vectors", () => {
  for (const vector of VECTORS) {
    it(`reproduces "${vector.name}"`, async () => {
      expect(fingerprintMaterial(vector.digest)).toEqual(vector.material);
      expect(await structureFingerprint(vector.digest)).toBe(
        vector.fingerprint,
      );
      expect(vector.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it("is order-independent across template refs", () => {
    expect(byName("two-collections-reordered-refs").fingerprint).toBe(
      byName("two-collections").fingerprint,
    );
  });

  it("ignores single and refused templates", () => {
    expect(byName("single-and-refused-ignored").fingerprint).toBe(
      byName("two-collections").fingerprint,
    );
  });

  it("changes when an item key or a collection template changes", () => {
    const base = byName("two-collections").fingerprint;
    expect(byName("item-key-added-changes").fingerprint).not.toBe(base);
    expect(byName("template-renamed-changes").fingerprint).not.toBe(base);
  });

  it("hashes the empty material for a digest without collections", () => {
    expect(byName("no-collections").fingerprint).toBe(
      byName("empty").fingerprint,
    );
    expect(byName("empty").fingerprint).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("the parity fixture vector matches a fresh build of the fixture digest", async () => {
    const fixture = loadParityFixture();
    const { digest } = buildStructureDigest(fixture.capture, {
      authorizedOrigin: fixture.authorizedOrigin,
      links: fixture.links,
    });
    expect(await structureFingerprint(digest)).toBe(
      byName("legacy-parity-fixture").fingerprint,
    );
  });
});

describe("itemShapeSignature mirrors shapes.js over a ShapeNode", () => {
  const value = {
    id: 7,
    name: "x",
    tags: ["a", "b"],
    owner: { id: 1, name: "y", meta: { deep: true } },
    flags: null,
    ok: false,
  };
  const node = {
    kind: "object",
    keys: {
      id: { kind: "number", class: "int" },
      name: { kind: "string", class: "text", lengthBucket: "≤8" },
      tags: {
        kind: "array",
        items: { kind: "string", class: "text", lengthBucket: "≤8" },
        lengthBucket: "2-9",
      },
      owner: {
        kind: "object",
        keys: {
          id: { kind: "number", class: "int" },
          name: { kind: "string", class: "text", lengthBucket: "≤8" },
          meta: { kind: "object", keys: { deep: { kind: "boolean" } } },
        },
      },
      flags: { kind: "null" },
      ok: { kind: "boolean" },
    },
  };

  it("produces the same depth-2 signature as shapeSignature over the value", () => {
    expect(itemShapeSignature(node)).toBe(shapeSignature(value));
    expect(itemShapeSignature(node)).toBe(
      "object{array[string]*1,boolean*1,null*1,number*1,object{number*1,object(*)*1,string*1}*1,string*1}",
    );
  });

  it("signs mixed and malformed nodes without throwing", () => {
    expect(itemShapeSignature({ kind: "mixed" })).toBe("mixed");
    expect(itemShapeSignature({ kind: "weird" })).toBe("unsupported");
    expect(itemShapeSignature(null)).toBe("unsupported");
  });

  it("locates the item shape by the first collection path, or null", () => {
    const template = {
      role: "collection",
      collectionPaths: [["data", "rows"]],
      shape: {
        kind: "object",
        keys: {
          data: {
            kind: "object",
            keys: {
              rows: {
                kind: "array",
                items: { kind: "object", keys: {} },
                lengthBucket: "1",
              },
            },
          },
        },
      },
    };
    expect(collectionItemShape(template)).toEqual({ kind: "object", keys: {} });
    expect(
      collectionItemShape({ ...template, collectionPaths: [["data"]] }),
    ).toBeNull();
    expect(
      collectionItemShape({ ...template, collectionPaths: [] }),
    ).toBeNull();
  });

  it("refuses a malformed digest", () => {
    expect(() => fingerprintMaterial(null)).toThrow("invalid_digest");
    expect(() =>
      fingerprintMaterial({ templates: [{ role: "collection", method: 1 }] }),
    ).toThrow("invalid_digest");
  });
});
