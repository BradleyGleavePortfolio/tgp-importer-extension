import { describe, it, expect, vi } from "vitest";
import { runReplay, AbortError, isAborted } from "../shared/replay/engine.js";

// Second engine spec: edge shapes that the mandated matrix leans on but that are
// distinct enough to warrant their own focused cases — body-as-array responses,
// missing id fields, id-set de-duplication feeding fan-out, empty fan-out sets,
// custom pagination params, retry exhaustion on 5xx, non-string cursor tokens,
// and a fetcher that throws AbortError directly. All IO is injected.

const API = "https://api.test";
const ORIGINS = [API];

function bp(steps, extra = {}) {
  return { platform: "test", apiBase: API, rateLimitMs: 0, steps, ...extra };
}
function makeCollector() {
  const emitted = [];
  const emit = async (entityType, batch) => {
    for (const e of batch) emitted.push({ entityType, ...e });
  };
  return { emitted, emit };
}
const fastClock = { now: () => 0, sleep: () => Promise.resolve() };

function run(opts) {
  return runReplay({ allowedOrigins: ORIGINS, ...fastClock, ...opts });
}

describe("runReplay — itemsPath empty means the body IS the array", () => {
  it("emits every element when the response body is a bare array", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const { emitted, emit } = makeCollector();
    const blueprint = bp([
      {
        id: "s",
        entityType: "thing",
        template: "/things",
        itemsPath: [],
        idField: "id",
      },
    ]);
    const result = await run({ blueprint, fetchJson, emit });
    expect(result.entities).toBe(3);
    expect(emitted.map((e) => e.sourceId)).toEqual(["a", "b", "c"]);
  });
});

describe("runReplay — item missing its idField", () => {
  it("still emits the item exactly once with a synthesized dedupe key", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValue({ items: [{ name: "no-id-here" }] });
    const { emitted, emit } = makeCollector();
    const blueprint = bp([
      {
        id: "s",
        entityType: "thing",
        template: "/things",
        itemsPath: ["items"],
        idField: "id",
      },
    ]);
    const result = await run({ blueprint, fetchJson, emit });
    expect(result.entities).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual({ name: "no-id-here" });
    // A synthesized (id-less) source id is never collected for fan-out.
    expect(emitted[0].sourceId).toBeTruthy();
    expect(emitted[0].sourceId).not.toContain("://");
  });
});

describe("runReplay — id-set de-duplication across pages feeds fan-out once", () => {
  it("issues one child pass per unique parent id even if the parent repeats", async () => {
    const fetchJson = vi.fn(async (url) => {
      if (url === `${API}/parents?page=1`)
        return { items: [{ id: "p1" }, { id: "p1" }] };
      if (url === `${API}/parents?page=2`) return { items: [{ id: "p1" }] };
      if (url === `${API}/parents?page=3`) return { items: [] };
      if (url === `${API}/parents/p1/kids`) return { kids: [{ id: "k1" }] };
      throw new Error(`unexpected ${url}`);
    });
    const { emitted, emit } = makeCollector();
    const blueprint = bp([
      {
        id: "parents",
        entityType: "parent",
        template: "/parents",
        itemsPath: ["items"],
        idField: "id",
        collectAs: "parentIds",
        pagination: { style: "page", param: "page", start: 1 },
      },
      {
        id: "kids",
        entityType: "kid",
        template: "/parents/:id/kids",
        forEach: "parentIds",
        itemsPath: ["kids"],
        idField: "id",
      },
    ]);
    const result = await run({ blueprint, fetchJson, emit });
    expect(result.status).toBe("complete");
    const kids = emitted.filter((e) => e.entityType === "kid");
    expect(kids).toHaveLength(1); // p1 collected once -> one /parents/p1/kids call
  });
});

describe("runReplay — empty fan-out set", () => {
  it("makes no child requests when the parent step collected nothing", async () => {
    const fetchJson = vi.fn(async (url) => {
      if (url === `${API}/parents?page=1`) return { items: [] };
      throw new Error(`should not fetch children: ${url}`);
    });
    const { emitted, emit } = makeCollector();
    const blueprint = bp([
      {
        id: "parents",
        entityType: "parent",
        template: "/parents",
        itemsPath: ["items"],
        idField: "id",
        collectAs: "parentIds",
        pagination: { style: "page", param: "page", start: 1 },
      },
      {
        id: "kids",
        entityType: "kid",
        template: "/parents/:id/kids",
        forEach: "parentIds",
        itemsPath: ["kids"],
        idField: "id",
      },
    ]);
    const result = await run({ blueprint, fetchJson, emit });
    // A clean walk that yielded nothing is "empty", never "complete": the far
    // likelier explanation is adapter drift, not a coach with no data.
    expect(result.status).toBe("empty");
    expect(emitted).toHaveLength(0);
    expect(fetchJson).toHaveBeenCalledTimes(1); // only the empty parent page
  });
});

describe("runReplay — custom pagination param + start", () => {
  it("honours a non-default page param name and start index", async () => {
    const seen = [];
    const fetchJson = vi.fn(async (url) => {
      const p = new URL(url).searchParams.get("offset");
      seen.push(p);
      return p === "0" ? { rows: [{ id: 1 }] } : { rows: [] };
    });
    const { emit } = makeCollector();
    const blueprint = bp([
      {
        id: "s",
        entityType: "row",
        template: "/rows",
        itemsPath: ["rows"],
        idField: "id",
        pagination: { style: "page", param: "offset", start: 0 },
      },
    ]);
    await run({ blueprint, fetchJson, emit });
    expect(seen).toEqual(["0", "1"]); // started at 0, advanced to 1, empty -> stop
  });
});

describe("runReplay — 5xx retry exhaustion is bounded", () => {
  it("retries a persistent 500 up to maxAttempts then skips the page", async () => {
    const err = new Error("boom");
    err.name = "HttpError";
    err.status = 500;
    const fetchJson = vi.fn(async () => {
      throw err;
    });
    const { emit } = makeCollector();
    const blueprint = bp([
      {
        id: "s",
        entityType: "thing",
        template: "/things",
        itemsPath: ["items"],
        idField: "id",
      },
    ]);
    const result = await run({ blueprint, fetchJson, emit, maxAttempts: 4 });
    // Persistent 5xx exhausts retries -> page skipped (degraded); nothing
    // emitted -> failed, never a dishonest complete.
    expect(result.status).toBe("failed");
    expect(result.degraded).toBe(true);
    expect(fetchJson).toHaveBeenCalledTimes(4);
  });

  it("does not retry at all when maxAttempts is 1", async () => {
    const err = new Error("t");
    err.name = "TimeoutError";
    const fetchJson = vi.fn(async () => {
      throw err;
    });
    const { emit } = makeCollector();
    const blueprint = bp([
      {
        id: "s",
        entityType: "thing",
        template: "/things",
        itemsPath: ["items"],
        idField: "id",
      },
    ]);
    await run({ blueprint, fetchJson, emit, maxAttempts: 1 });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
});

describe("runReplay — cursor with a non-string next token stops", () => {
  it("treats a numeric/absent next token as end of list", async () => {
    const fetchJson = vi.fn(async () => ({
      items: [{ id: 1 }],
      meta: { next: 999 },
    }));
    const { emitted, emit } = makeCollector();
    const blueprint = bp([
      {
        id: "feed",
        entityType: "post",
        template: "/feed",
        itemsPath: ["items"],
        idField: "id",
        pagination: {
          style: "cursor",
          param: "cursor",
          nextPath: ["meta", "next"],
        },
      },
    ]);
    const result = await run({ blueprint, fetchJson, emit });
    expect(result.status).toBe("complete");
    expect(fetchJson).toHaveBeenCalledTimes(1); // non-string token -> no advance
    expect(emitted.map((e) => e.sourceId)).toEqual(["1"]);
  });
});

describe("runReplay — fetcher throwing AbortError", () => {
  it("ends as cancelled when fetchJson itself throws AbortError", async () => {
    const fetchJson = vi.fn(async () => {
      throw new AbortError();
    });
    const { emit } = makeCollector();
    const blueprint = bp([
      {
        id: "s",
        entityType: "thing",
        template: "/things",
        itemsPath: ["items"],
        idField: "id",
      },
    ]);
    const result = await run({ blueprint, fetchJson, emit });
    expect(result.status).toBe("cancelled");
    expect(isAborted(new AbortError())).toBe(true);
  });
});

describe("runReplay — multiple independent steps run in order", () => {
  it("walks each un-paginated step once and labels entities per step", async () => {
    const fetchJson = vi.fn(async (url) => {
      if (url === `${API}/orgs`) return { organizations: [{ id: "o1" }] };
      if (url === `${API}/settings`)
        return { settings: [{ id: "s1" }, { id: "s2" }] };
      throw new Error(`unexpected ${url}`);
    });
    const { emitted, emit } = makeCollector();
    const blueprint = bp([
      {
        id: "orgs",
        entityType: "org",
        template: "/orgs",
        itemsPath: ["organizations"],
        idField: "id",
      },
      {
        id: "settings",
        entityType: "setting",
        template: "/settings",
        itemsPath: ["settings"],
        idField: "id",
      },
    ]);
    const result = await run({ blueprint, fetchJson, emit });
    expect(result.status).toBe("complete");
    expect(emitted.map((e) => `${e.entityType}:${e.sourceId}`)).toEqual([
      "org:o1",
      "setting:s1",
      "setting:s2",
    ]);
  });
});

describe("runReplay — non-object items are skipped safely", () => {
  it("ignores null / string / number entries in the items array without throwing", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValue({ items: [null, "nope", 7, { id: "real" }] });
    const { emitted, emit } = makeCollector();
    const blueprint = bp([
      {
        id: "s",
        entityType: "thing",
        template: "/things",
        itemsPath: ["items"],
        idField: "id",
      },
    ]);
    const result = await run({ blueprint, fetchJson, emit });
    expect(result.status).toBe("complete");
    // All four entries emit (each is a distinct payload); only the object carries a real id.
    expect(emitted).toHaveLength(4);
    expect(emitted.some((e) => e.sourceId === "real")).toBe(true);
  });
});

describe("runReplay — template with multiple :params", () => {
  it("fills every :param in a forEach template from the same collected id", async () => {
    const fetchJson = vi.fn(async (url) => {
      if (url === `${API}/a`) return { items: [{ id: "42" }] };
      if (url === `${API}/x/42/y/42`) return { items: [{ id: "child" }] };
      throw new Error(`unexpected ${url}`);
    });
    const { emitted, emit } = makeCollector();
    const blueprint = bp([
      {
        id: "a",
        entityType: "a",
        template: "/a",
        itemsPath: ["items"],
        idField: "id",
        collectAs: "ids",
      },
      {
        id: "b",
        entityType: "b",
        template: "/x/:id/y/:id",
        forEach: "ids",
        itemsPath: ["items"],
        idField: "id",
      },
    ]);
    const result = await run({ blueprint, fetchJson, emit });
    expect(result.status).toBe("complete");
    expect(
      emitted.filter((e) => e.entityType === "b").map((e) => e.sourceId),
    ).toEqual(["child"]);
  });
});

describe("runReplay — digit-led :param substitutes (grammar unified with normalizer)", () => {
  it("fills a digit-led placeholder like :1 the same as a named one", async () => {
    // The normalizer accepts :param names from [A-Za-z0-9_] (digit-led included);
    // the engine must substitute exactly those, or an accepted template would be
    // fetched with a literal ":1" still in the path.
    const fetchJson = vi.fn(async (url) => {
      if (url === `${API}/seed`) return { items: [{ id: "42" }] };
      if (url === `${API}/x/42/y/42`) return { items: [{ id: "child" }] };
      throw new Error(`unexpected ${url}`); // literal ":1"/":name" would land here
    });
    const { emitted, emit } = makeCollector();
    const blueprint = bp([
      {
        id: "seed",
        entityType: "seed",
        template: "/seed",
        itemsPath: ["items"],
        idField: "id",
        collectAs: "ids",
      },
      // one digit-led placeholder + one named placeholder, both from the same id.
      {
        id: "kid",
        entityType: "kid",
        template: "/x/:1/y/:name",
        forEach: "ids",
        itemsPath: ["items"],
        idField: "id",
      },
    ]);
    const result = await run({ blueprint, fetchJson, emit });
    expect(result.status).toBe("complete");
    expect(fetchJson).toHaveBeenCalledWith(
      `${API}/x/42/y/42`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(
      emitted.filter((e) => e.entityType === "kid").map((e) => e.sourceId),
    ).toEqual(["child"]);
  });
});

describe("runReplay — no pacing when rateLimitMs is 0", () => {
  it("never calls sleep when the blueprint imposes no rate limit", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fetchJson = vi.fn(async (url) => {
      const p = new URL(url).searchParams.get("page");
      return p === "1" ? { items: [{ id: 1 }] } : { items: [] };
    });
    const { emit } = makeCollector();
    const blueprint = bp([
      {
        id: "s",
        entityType: "thing",
        template: "/things",
        itemsPath: ["items"],
        idField: "id",
        pagination: { style: "page", param: "page", start: 1 },
      },
    ]); // rateLimitMs defaults to 0
    await run({ blueprint, fetchJson, emit, now: () => 0, sleep });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("runReplay — abort between steps", () => {
  it("does not start the next step once aborted after the first completes", async () => {
    const controller = new AbortController();
    const fetchJson = vi.fn(async (url) => {
      if (url === `${API}/first`) {
        controller.abort();
        return { items: [] };
      }
      throw new Error(`should not fetch ${url}`);
    });
    const { emit } = makeCollector();
    const blueprint = bp([
      {
        id: "first",
        entityType: "a",
        template: "/first",
        itemsPath: ["items"],
        idField: "id",
      },
      {
        id: "second",
        entityType: "b",
        template: "/second",
        itemsPath: ["items"],
        idField: "id",
      },
    ]);
    const result = await run({
      blueprint,
      fetchJson,
      emit,
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(fetchJson).toHaveBeenCalledTimes(1); // second step never fetched
  });
});

describe("runReplay — malformed body ends cursor pagination", () => {
  it("stops when a malformed page yields no next cursor", async () => {
    let call = 0;
    const fetchJson = vi.fn(async () => {
      call += 1;
      if (call === 1) return { items: [{ id: 1 }], meta: { next: "C1" } };
      const e = new Error("bad");
      e.name = "MalformedResponseError";
      throw e;
    });
    const { emitted, emit } = makeCollector();
    const blueprint = bp([
      {
        id: "feed",
        entityType: "post",
        template: "/feed",
        itemsPath: ["items"],
        idField: "id",
        pagination: {
          style: "cursor",
          param: "cursor",
          nextPath: ["meta", "next"],
        },
      },
    ]);
    const result = await run({ blueprint, fetchJson, emit });
    // page 1 ok (emits id 1), page 2 malformed -> skipped (degraded) -> no next
    // cursor -> terminate. Emitted something but the walk was not whole: partial.
    expect(result.status).toBe("partial");
    expect(result.degraded).toBe(true);
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(emitted.map((e) => e.sourceId)).toEqual(["1"]);
  });
});
