import { describe, expect, it } from "vitest";
import { inferUrlTemplates } from "../shared/blueprint/url-templates.js";
import {
  selectClusterObservations,
  validateObservationMembership,
} from "../shared/blueprint/membership.js";

const origin = "https://coach.example";
const row = (path) => ({ origin, path, method: "GET", queryKeys: [] });
const tibetan = "\u0F73";
const boundaryRows = (padding, ids = [1, 2, 3]) => {
  const fixed = [
    ...Array(29).fill(tibetan.repeat(68)),
    tibetan.repeat(74) + "a".repeat(padding),
  ];
  return ids.map((id) => row("/" + [...fixed, String(id)].join("/")));
};
const encodedLength = (path) =>
  path
    .split("/")
    .map((part) => encodeURIComponent(part.normalize("NFC")))
    .join("/").length;

describe("post-substitution pathPattern bounds", () => {
  it.each([false, true])(
    "rejects the exact U+0F73 36866-character pattern (membership=%s)",
    (membership) => {
      const rows = boundaryRows(4);
      expect(tibetan.normalize("NFC")).toHaveLength(2);
      expect(rows.map((entry) => entry.path.length)).toEqual([
        2082, 2082, 2082,
      ]);
      expect(rows.map((entry) => encodedLength(entry.path))).toEqual([
        36864, 36864, 36864,
      ]);
      const result = inferUrlTemplates(rows, { membership });
      expect(result.clusters).toEqual([]);
      expect(result.excluded).toEqual([
        { reason: "invalid_observation", count: 3 },
      ]);
      if (membership) {
        expect(result.membership).toEqual({
          observationCount: 3,
          clusters: [],
          excluded: [0, 1, 2].map((ref) => ({
            ref,
            reason: "invalid_observation",
          })),
        });
        const checked = validateObservationMembership(rows, result.membership);
        expect(checked.valid).toBe(true);
        expect(checked.reasons).toEqual([]);
        expect(checked.checked).toEqual({ clusters: 0, references: 3 });
      } else expect(result.membership).toBeUndefined();
    },
  );

  it.each([
    [2, [1, 2, 3], 36864],
    [3, [1, 2, 3], 36865],
    [2, [11, 12, 13], 36864],
    [3, [11, 12, 13], 36865],
  ])(
    "handles padding %i and IDs %j at emitted length %i",
    (padding, ids, patternLength) => {
      const rows = boundaryRows(padding, ids);
      expect(rows.every((entry) => encodedLength(entry.path) <= 36864)).toBe(
        true,
      );
      const result = inferUrlTemplates(rows, { membership: true });
      const { membership, ...plain } = result;
      expect(inferUrlTemplates(rows)).toEqual(plain);
      const checked = validateObservationMembership(rows, membership);
      expect(checked.valid).toBe(true);
      expect(checked.reasons).toEqual([]);
      if (patternLength === 36864) {
        expect(result.clusters).toHaveLength(1);
        expect(result.clusters[0].pathPattern).toHaveLength(patternLength);
        expect(result.clusters[0].pathPattern.endsWith("/:id")).toBe(true);
        expect(result.clusters[0].dynamicSegments).toBe(1);
        expect(result.excluded).toEqual([]);
        expect(membership.clusters[0].refs).toEqual([0, 1, 2]);
        expect(
          selectClusterObservations(
            rows,
            checked.membership,
            result.clusters[0],
          ),
        ).toEqual(rows);
      } else {
        expect(result.clusters).toEqual([]);
        expect(result.excluded).toEqual([
          { reason: "invalid_observation", count: 3 },
        ]);
        expect(membership.excluded.map((entry) => entry.ref)).toEqual([
          0, 1, 2,
        ]);
      }
    },
  );

  it.each([1, 11])(
    "preserves a static short candidate %i at the exact literal ceiling",
    (id) => {
      const rows = boundaryRows(5 - String(id).length, [id, id, id]);
      expect(encodedLength(rows[0].path)).toBe(36864);
      const result = inferUrlTemplates(rows, { membership: true });
      expect(result.clusters).toHaveLength(1);
      expect(result.clusters[0].pathPattern).toHaveLength(36864);
      expect(result.clusters[0].dynamicSegments).toBe(0);
      expect(result.excluded).toEqual([]);
      expect(
        validateObservationMembership(rows, result.membership).reasons,
      ).toEqual([]);
    },
  );

  it("charges every row when two substitutions jointly exceed the ceiling", () => {
    const fixed = [
      ...Array(29).fill(tibetan.repeat(68)),
      tibetan.repeat(73) + "a".repeat(20),
    ];
    const rows = [1, 2, 3].map((id) =>
      row("/" + [...fixed, String(id), String(id)].join("/")),
    );
    expect(encodedLength(rows[0].path)).toBe(36864);
    const result = inferUrlTemplates(rows, { membership: true });
    expect(result.clusters).toEqual([]);
    expect(result.excluded).toEqual([
      { reason: "invalid_observation", count: 3 },
    ]);
    expect(result.membership.excluded.map((entry) => entry.ref)).toEqual([
      0, 1, 2,
    ]);
    expect(
      validateObservationMembership(rows, result.membership).reasons,
    ).toEqual([]);
  });

  it("keeps valid partitions and merges invalid counts without losing physical refs", () => {
    const long = boundaryRows(4);
    const rows = [
      long[0],
      row("/items/1"),
      null,
      long[1],
      row("/items/2"),
      long[2],
      row("/items/3"),
    ];
    const result = inferUrlTemplates(rows, { membership: true });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].pathPattern).toBe("/items/:id");
    expect(result.clusters[0].observations).toBe(3);
    expect(result.excluded).toEqual([
      { reason: "invalid_observation", count: 4 },
    ]);
    expect(result.membership.clusters[0].refs).toEqual([1, 4, 6]);
    expect(result.membership.excluded).toEqual(
      [0, 2, 3, 5].map((ref) => ({ ref, reason: "invalid_observation" })),
    );
    const checked = validateObservationMembership(rows, result.membership);
    expect(checked.valid).toBe(true);
    expect(checked.reasons).toEqual([]);
    expect(
      selectClusterObservations(rows, checked.membership, result.clusters[0]),
    ).toEqual([rows[1], rows[4], rows[6]]);
    const { membership, ...plain } = result;
    expect(inferUrlTemplates(rows)).toEqual(plain);
    expect(membership.observationCount).toBe(7);
  });
});

describe("whole-batch invalid_observations diagnostics", () => {
  it.each([false, true])(
    "counts all 1000 physical rows when slot 999 is an accessor (membership=%s)",
    (membership) => {
      const rows = Array.from({ length: 1000 }, () => row("/items/1"));
      let reads = 0;
      Object.defineProperty(rows, "999", {
        get() {
          reads++;
          throw new Error("PRIVATE accessor must not run");
        },
      });
      const result = inferUrlTemplates(rows, { membership });
      expect(reads).toBe(0);
      expect(result).toEqual({
        clusters: [],
        excluded: [{ reason: "invalid_observations", count: 1000 }],
      });
      expect(result.membership).toBeUndefined();
    },
  );

  it.each([0, 3, 1000])(
    "retains captured length %i when an option accessor prevents inference",
    (length) => {
      const rows = Array.from({ length }, () => row("/items/1"));
      let reads = 0;
      const options = {
        get membership() {
          reads++;
          throw new Error("PRIVATE option must not run");
        },
      };
      expect(inferUrlTemplates(rows, options)).toEqual({
        clusters: [],
        excluded: [{ reason: "invalid_observations", count: length }],
      });
      expect(reads).toBe(0);
    },
  );

  it("uses the captured length once even when a later descriptor trap changes it", () => {
    const target = Array.from({ length: 1000 }, () => row("/items/1"));
    const counts = new Map();
    let gets = 0;
    const rows = new Proxy(target, {
      get() {
        gets++;
        throw new Error("PRIVATE ordinary get must not run");
      },
      getOwnPropertyDescriptor(array, key) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (key === "999") {
          array.length = 0;
          throw new Error("PRIVATE failed snapshot");
        }
        return Reflect.getOwnPropertyDescriptor(array, key);
      },
    });
    expect(inferUrlTemplates(rows, { membership: true })).toEqual({
      clusters: [],
      excluded: [{ reason: "invalid_observations", count: 1000 }],
    });
    expect(counts.get("length")).toBe(1);
    expect(counts.get("999")).toBe(1);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
    expect(gets).toBe(0);
    expect(target).toHaveLength(0);
  });

  it("uses fallback one only when the physical array length cannot be captured", () => {
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const inaccessible = new Proxy([], {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE length descriptor");
      },
    });
    for (const rows of [null, {}, revoked.proxy, inaccessible]) {
      expect(inferUrlTemplates(rows, { membership: true })).toEqual({
        clusters: [],
        excluded: [{ reason: "invalid_observations", count: 1 }],
      });
    }
  });

  it("retains the observation-limit diagnostic before touching oversized slots", () => {
    const rows = Array(1001);
    let reads = 0;
    Object.defineProperty(rows, "0", {
      get() {
        reads++;
        throw new Error("PRIVATE oversized index");
      },
    });
    expect(inferUrlTemplates(rows, { membership: true })).toEqual({
      clusters: [],
      excluded: [{ reason: "observation_limit", count: 1001 }],
    });
    expect(reads).toBe(0);
  });
});
