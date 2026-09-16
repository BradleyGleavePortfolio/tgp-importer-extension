import { describe, expect, it } from "vitest";
import { normalizeCaptureSnapshot } from "../shared/blueprint/input.js";
import { inferUrlTemplates } from "../shared/blueprint/url-templates.js";
import {
  selectClusterObservations,
  validateObservationMembership,
} from "../shared/blueprint/membership.js";

const origin = "https://coach.example";
const row = (path) => ({ origin, path, method: "GET", queryKeys: [] });
const rowsFor = () => [101, 102, 103].map((id) => row(`/workouts/${id}`));
function setup() {
  const rows = rowsFor();
  const result = inferUrlTemplates(rows, { membership: true });
  return { rows, result, claim: structuredClone(result.membership) };
}
function accessor(object, key, value) {
  let reads = 0;
  Object.defineProperty(object, key, {
    configurable: true,
    get() {
      reads++;
      if (reads > 1) throw new Error("PRIVATE repeated getter");
      return value;
    },
  });
  return () => reads;
}
function poisonIterator(array) {
  let calls = 0;
  Object.defineProperty(array, Symbol.iterator, {
    value: function* () {
      calls++;
      for (let i = 0; i < 5001; i++) yield array[0];
      throw new Error("PRIVATE unbounded iterator guard");
    },
  });
  return () => calls;
}

describe("hostile membership boundaries", () => {
  it.each(["clusters", "excluded", "refs"])(
    "ignores custom or unbounded %s iterators",
    (field) => {
      const { rows, claim } = setup();
      const array = field === "refs" ? claim.clusters[0].refs : claim[field];
      const calls = poisonIterator(array);
      const outcome = validateObservationMembership(rows, claim);
      expect(calls()).toBe(0);
      expect(outcome.reasons).toEqual([]);
      expect(outcome.checked).toEqual({ clusters: 1, references: 3 });
    },
  );

  it.each(["clusters", "excluded", "observationCount"])(
    "does not invoke top-level %s accessors",
    (field) => {
      const { rows, claim } = setup();
      const reads = accessor(claim, field, claim[field]);
      const outcome = validateObservationMembership(rows, claim);
      expect(reads()).toBe(0);
      expect(outcome.reasons).toEqual(["malformed_membership"]);
      expect(outcome.membership).toBeNull();
    },
  );

  it("reads each array descriptor once, with no proxy get or iterator dispatch", () => {
    const { rows, claim } = setup();
    const counts = new Map();
    let gets = 0;
    claim.clusters[0].refs = new Proxy(claim.clusters[0].refs, {
      get() {
        gets++;
        throw new Error("PRIVATE get trap");
      },
      getOwnPropertyDescriptor(target, key) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const outcome = validateObservationMembership(rows, claim);
    expect(outcome.reasons).toEqual([]);
    expect(gets).toBe(0);
    expect([...counts.entries()]).toEqual([
      ["length", 1],
      ["0", 1],
      ["1", 1],
      ["2", 1],
    ]);
  });

  it.each(["clusters", "excluded", "refs"])(
    "rejects inherited sparse %s indices",
    (field) => {
      const { rows, claim } = setup();
      if (field === "excluded") {
        rows.push(null);
        Object.assign(
          claim,
          inferUrlTemplates(rows, { membership: true }).membership,
        );
      }
      const array = field === "refs" ? claim.clusters[0].refs : claim[field];
      const proto = Object.create(Array.prototype);
      Object.defineProperty(proto, "0", { value: array[0] });
      delete array[0];
      Object.setPrototypeOf(array, proto);
      expect(validateObservationMembership(rows, claim).reasons).toEqual([
        "malformed_membership",
      ]);
    },
  );

  it("preserves null-prototype data records", () => {
    const { rows, claim } = setup();
    Object.setPrototypeOf(claim, null);
    Object.setPrototypeOf(claim.clusters[0], null);
    expect(validateObservationMembership(rows, claim).reasons).toEqual([]);
  });

  it.each(["origin", "method", "pathPattern"])(
    "rejects throwing %s getters without disclosure",
    (field) => {
      const { rows, claim } = setup();
      const reads = accessor(claim.clusters[0], field, 1n);
      const outcome = validateObservationMembership(rows, claim);
      expect(reads()).toBe(0);
      expect(outcome.reasons).toEqual(["malformed_membership"]);
      expect(JSON.stringify(outcome)).not.toContain("PRIVATE");
    },
  );

  it("gives methods a four-character bound independent of origin length", () => {
    const { rows, claim } = setup();
    claim.clusters[0].method = "GET!!";
    expect(validateObservationMembership(rows, claim).reasons).toEqual([
      "malformed_membership",
    ]);
  });

  it.each([null, 17, "PRIVATE", [], 1n])(
    "attributes a referenced non-record accurately: %s",
    (value) => {
      const { rows, claim } = setup();
      Object.defineProperty(rows, "0", { value, configurable: true });
      const outcome = validateObservationMembership(rows, claim);
      expect(outcome.reasons).toContain("invalid_observation");
      expect(outcome.reasons).not.toContain("origin_mismatch");
      expect(outcome.reasons).not.toContain("method_mismatch");
      expect(outcome.membership).toBeNull();
      expect(JSON.stringify(outcome)).not.toContain("PRIVATE");
    },
  );

  it.each(["rows", "claim", "clusters", "refs"])(
    "sanitizes revoked %s proxies",
    (field) => {
      const state = setup();
      const revoked = Proxy.revocable([], {});
      revoked.revoke();
      if (field === "rows" || field === "claim") state[field] = revoked.proxy;
      else if (field === "clusters") state.claim.clusters = revoked.proxy;
      else state.claim.clusters[0].refs = revoked.proxy;
      const outcome = validateObservationMembership(state.rows, state.claim);
      expect(outcome.reasons).toEqual([
        field === "rows" ? "invalid_observations" : "malformed_membership",
      ]);
      expect(outcome.membership).toBeNull();
    },
  );
});

describe("physical observation authority", () => {
  it.each(["forged", "omitted", "null"])(
    "ignores overridden entries in on and off modes: %s",
    (kind) => {
      const { rows, result } = setup();
      let calls = 0;
      rows.entries =
        kind === "null"
          ? null
          : function* () {
              calls++;
              if (kind === "forged")
                for (let i = 0; i < 3; i++)
                  yield [i, row(`/clients/${101 + i}`)];
            };
      expect(inferUrlTemplates(rows)).toEqual({
        clusters: result.clusters,
        excluded: result.excluded,
      });
      const actual = inferUrlTemplates(rows, { membership: true });
      expect(actual).toEqual(result);
      expect(calls).toBe(0);
      expect(actual.membership.clusters[0].refs).toEqual([0, 1, 2]);
      const checked = validateObservationMembership(rows, actual.membership);
      expect(checked.reasons).toEqual([]);
      expect(
        selectClusterObservations(rows, checked.membership, actual.clusters[0]),
      ).toEqual(rowsFor());
    },
  );

  it("never uses observation iteration when sealing or producing", () => {
    const { rows, claim } = setup();
    const calls = poisonIterator(rows);
    const outcome = validateObservationMembership(rows, claim);
    expect(outcome.reasons).toEqual([]);
    expect(calls()).toBe(0);
    expect(
      selectClusterObservations(rows, outcome.membership, claim.clusters[0]),
    ).toEqual(rowsFor());
  });

  it("ignores inherited observation indices, excludes physical holes", () => {
    const { rows } = setup();
    const proto = Object.create(Array.prototype);
    Object.defineProperty(proto, "0", { value: rows[0] });
    delete rows[0];
    Object.setPrototypeOf(rows, proto);
    const result = inferUrlTemplates(rows, { membership: true });
    expect(result.membership.excluded).toEqual([
      { ref: 0, reason: "invalid_observation" },
    ]);
    expect(result.membership.clusters.flatMap((entry) => entry.refs)).toEqual([
      1, 2,
    ]);
    expect(
      validateObservationMembership(rows, result.membership).reasons,
    ).toEqual([]);
  });

  it.each(["path", "origin", "method", "queryKeys"])(
    "does not invoke observation %s accessors",
    (field) => {
      const { rows } = setup();
      const reads = accessor(rows[0], field, rows[0][field]);
      const result = inferUrlTemplates(rows, { membership: true });
      expect(reads()).toBe(0);
      expect(result.excluded).toEqual([
        { reason: "invalid_observations", count: 1 },
      ]);
      expect(result.membership).toBeUndefined();
    },
  );

  it("copies query keys by own index without caller filter/map/iterator", () => {
    const rows = rowsFor();
    const keys = ["page", "CURSOR"];
    let calls = 0;
    keys.filter = () => {
      calls++;
      throw new Error("PRIVATE filter");
    };
    rows[0].queryKeys = keys;
    expect(inferUrlTemplates(rows).clusters[0].queryKeys).toEqual([
      "cursor",
      "page",
    ]);
    expect(calls).toBe(0);
  });
});

describe("selector checked snapshots", () => {
  it.each(["origin", "method", "pathPattern"])(
    "rejects a mutating cluster %s getter before checking rows",
    (field) => {
      const { rows, claim } = setup();
      const checked = validateObservationMembership(rows, claim);
      const key = { ...claim.clusters[0] };
      let reads = 0;
      Object.defineProperty(key, field, {
        get() {
          reads++;
          rows[0] = row("/clients/999");
          return claim.clusters[0][field];
        },
      });
      expect(
        selectClusterObservations(rows, checked.membership, key),
      ).toBeNull();
      expect(reads).toBe(0);
      expect(rows[0].path).toBe("/workouts/101");
    },
  );

  it("does not check an index getter then return its second value", () => {
    const { rows, claim } = setup();
    const checked = validateObservationMembership(rows, claim);
    const first = rows[0];
    let reads = 0;
    Object.defineProperty(rows, "0", {
      get() {
        return ++reads === 1 ? first : row("/clients/999");
      },
    });
    expect(
      selectClusterObservations(rows, checked.membership, claim.clusters[0]),
    ).toBeNull();
    expect(reads).toBe(0);
  });

  it("constructs the result from the checked descriptor snapshot, not later gets", () => {
    const original = rowsFor();
    let gets = 0;
    const rows = new Proxy(original, {
      get(target, key) {
        gets++;
        return key === "0" ? row("/clients/999") : Reflect.get(target, key);
      },
    });
    const result = inferUrlTemplates(rows, { membership: true });
    const checked = validateObservationMembership(rows, result.membership);
    expect(checked.reasons).toEqual([]);
    const selected = selectClusterObservations(
      rows,
      checked.membership,
      result.clusters[0],
    );
    expect(selected).toEqual(original);
    expect(selected[0]).toBe(original[0]);
    expect(gets).toBe(0);
  });

  it.each(["origin", "method", "pathPattern"])(
    "never coerces hostile selector %s values",
    (field) => {
      const { rows, claim } = setup();
      const checked = validateObservationMembership(rows, claim);
      let calls = 0;
      const coercion = {
        toJSON() {
          calls++;
          return claim.clusters[0][field];
        },
      };
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      for (const value of [1n, coercion, revoked.proxy]) {
        expect(
          selectClusterObservations(rows, checked.membership, {
            ...claim.clusters[0],
            [field]: value,
          }),
        ).toBeNull();
      }
      expect(calls).toBe(0);
      expect(
        selectClusterObservations(rows, checked.membership, revoked.proxy),
      ).toBeNull();
      expect(
        selectClusterObservations(
          revoked.proxy,
          checked.membership,
          claim.clusters[0],
        ),
      ).toBeNull();
    },
  );
});

describe("producer consumer representability", () => {
  it.each(["encoded pattern", "long origin"])(
    "validates real nonempty normalized %s data",
    (kind) => {
      const path =
        kind === "encoded pattern"
          ? "/" + Array(16).fill("!".repeat(250)).join("/")
          : "/workouts/101";
      const host =
        kind === "long origin"
          ? "https://" + Array(33).fill("a".repeat(63)).join(".") + ".example"
          : origin;
      const normalized = normalizeCaptureSnapshot([
        {
          url: host + path,
          method: "GET",
          statusCode: 200,
          responseBody: "{}",
        },
      ]);
      expect(normalized.observations).toHaveLength(1);
      const result = inferUrlTemplates(normalized.observations, {
        membership: true,
      });
      expect(result.membership.clusters).toHaveLength(1);
      if (kind === "encoded pattern")
        expect(result.clusters[0].pathPattern.length).toBe(12016);
      else expect(result.clusters[0].origin.length).toBeGreaterThan(2048);
      expect(
        validateObservationMembership(
          normalized.observations,
          result.membership,
        ).reasons,
      ).toEqual([]);
    },
  );

  it("distinguishes absent evidence from invalid claims and per-row rejection", () => {
    const { rows } = setup();
    for (const missing of [undefined, null, {}])
      expect(validateObservationMembership(rows, missing).reasons).toEqual([
        "malformed_membership",
      ]);
    const options = { maxSegments: 1 };
    const result = inferUrlTemplates(rows, { ...options, membership: true });
    expect(result.membership.excluded).toHaveLength(3);
    expect(
      validateObservationMembership(rows, result.membership, options).reasons,
    ).toEqual([]);
    expect(validateObservationMembership(null, undefined).reasons).toEqual([
      "invalid_observations",
    ]);
    expect(
      validateObservationMembership(Array(1001), undefined).reasons,
    ).toEqual(["observation_limit"]);
  });
});

it("enforces the same origin ceiling at producer and consumer boundaries", () => {
  for (const length of [4096, 4097]) {
    const host = "https://" + "a".repeat(length - 8);
    const rows = [row("/workouts/101")];
    rows[0].origin = host;
    const result = inferUrlTemplates(rows, { membership: true });
    expect(result.membership.clusters).toHaveLength(length === 4096 ? 1 : 0);
    expect(result.membership.excluded).toEqual(
      length === 4096 ? [] : [{ ref: 0, reason: "invalid_observation" }],
    );
    expect(
      validateObservationMembership(rows, result.membership).reasons,
    ).toEqual([]);
  }
});

it("reads all claimed and observation data descriptors at most once", () => {
  const { rows, claim } = setup();
  const counts = new Map();
  const track = (value, label) =>
    new Proxy(value, {
      getOwnPropertyDescriptor(target, key) {
        const name = `${label}:${String(key)}`;
        counts.set(name, (counts.get(name) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
  rows[0] = track(rows[0], "row");
  claim.clusters[0] = track(claim.clusters[0], "cluster");
  expect(
    validateObservationMembership(rows, track(claim, "claim")).reasons,
  ).toEqual([]);
  expect(counts.get("row:path")).toBe(1);
  expect(counts.get("claim:clusters")).toBe(1);
  expect(counts.get("cluster:origin")).toBe(1);
  expect([...counts.values()].every((count) => count === 1)).toBe(true);
});

it("sanitizes throwing own descriptor traps at every API boundary", () => {
  const { rows, claim } = setup();
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE descriptor marker");
      },
    },
  );
  expect(validateObservationMembership(rows, hostile).reasons).toEqual([
    "malformed_membership",
  ]);
  const checked = validateObservationMembership(rows, claim);
  expect(
    selectClusterObservations(rows, checked.membership, hostile),
  ).toBeNull();
  Object.defineProperty(rows[0], "path", {
    get() {
      throw new Error("PRIVATE getter marker");
    },
  });
  expect(inferUrlTemplates(rows).excluded).toEqual([
    { reason: "invalid_observations", count: 1 },
  ]);
  expect(validateObservationMembership(rows, claim).reasons).toEqual([
    "invalid_observations",
  ]);
});

it("rejects observation index accessors and option getters without invoking them", () => {
  const { rows, claim } = setup();
  const reads = accessor(rows, "0", rows[0]);
  expect(inferUrlTemplates(rows).excluded).toEqual([
    { reason: "invalid_observations", count: 1 },
  ]);
  expect(validateObservationMembership(rows, claim).reasons).toEqual([
    "invalid_observations",
  ]);
  expect(reads()).toBe(0);
  const options = {};
  const optionReads = accessor(options, "maxObservations", 3);
  expect(inferUrlTemplates(rowsFor(), options).excluded).toEqual([
    { reason: "invalid_observations", count: 1 },
  ]);
  expect(optionReads()).toBe(0);
});

it("never invokes a throwing top-level membership getter", () => {
  const { rows, claim } = setup();
  let reads = 0;
  Object.defineProperty(claim, "clusters", {
    get() {
      reads++;
      throw new Error("PRIVATE top-level marker");
    },
  });
  expect(validateObservationMembership(rows, claim).reasons).toEqual([
    "malformed_membership",
  ]);
  expect(reads).toBe(0);
});

it("bounds query-key text work before lowercase conversion", () => {
  const rows = rowsFor();
  rows[0].queryKeys = ["X".repeat(100000), "page"];
  const lower = String.prototype.toLowerCase;
  let oversizedCalls = 0;
  String.prototype.toLowerCase = function () {
    if (this.length > 64) {
      oversizedCalls++;
      throw new Error("PRIVATE unbounded text conversion");
    }
    return lower.call(this);
  };
  try {
    expect(inferUrlTemplates(rows).clusters[0]?.queryKeys).toEqual(["page"]);
    expect(oversizedCalls).toBe(0);
  } finally {
    String.prototype.toLowerCase = lower;
  }
});
