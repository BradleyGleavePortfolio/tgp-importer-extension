import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runReplay } from "../shared/replay/engine.js";
import { DEFAULT_BUDGETS, HARD_BUDGETS } from "../shared/replay/blueprint.js";

const origin = "https://api.test";
const step = (extra = {}) => ({
  id: "items",
  entityType: "item",
  template: "/items",
  itemsPath: ["items"],
  ...extra,
});
const blueprint = (steps, budgets = {}) => ({
  platform: "test",
  apiBase: origin,
  rateLimitMs: 0,
  steps,
  budgets,
});
async function execute(bp, bodies) {
  const fetchJson = vi.fn(async (_url) => bodies.shift());
  const emit = vi.fn(async (_type, _batch) => {});
  const result = await runReplay({
    blueprint: bp,
    allowedOrigins: [origin],
    fetchJson,
    emit,
  });
  return { result, fetchJson, emit };
}

describe("response boundary preserves data without inventing exhaustion", () => {
  it.each([{}, { items: null }, { items: {} }, { items: "bad" }, null, []])(
    "marks an invalid selected array as malformed: %j",
    async (bad) => {
      const { result, fetchJson, emit } = await execute(
        blueprint([step({ pagination: { style: "page" } })]),
        [{ items: [{ id: "saved" }] }, bad],
      );
      expect(result).toMatchObject({
        status: "partial",
        entities: 1,
        degraded: true,
        lastSkipStatus: "malformed",
        truncated: false,
        truncationReasons: [],
      });
      expect(fetchJson).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][1][0].sourceId).toBe("saved");
    },
  );
  it("fails an initial JSON null instead of classifying it as an empty list", async () => {
    const { result } = await execute(blueprint([step()]), [null]);
    expect(result).toMatchObject({
      status: "failed",
      lastSkipStatus: "malformed",
      entities: 0,
    });
  });
  it("accepts a real empty selected array", async () => {
    const { result } = await execute(blueprint([step()]), [{ items: [] }]);
    expect(result).toMatchObject({
      status: "empty",
      degraded: false,
      lastSkipStatus: null,
    });
  });
  it.each([0, 2, false, {}, [], "\uD800", "\uDC00", "x\uD800y"])(
    "rejects nonterminal invalid cursors without another request: %j",
    async (next) => {
      const { result, fetchJson, emit } = await execute(
        blueprint([
          step({ pagination: { style: "cursor", nextPath: ["next"] } }),
        ]),
        [{ items: [{ id: "saved" }], next }],
      );
      expect(result).toMatchObject({
        status: "partial",
        degraded: true,
        lastSkipStatus: "malformed",
        entities: 1,
      });
      expect(fetchJson).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("saved");
    },
  );
  it.each([undefined, null, ""])("retains terminal cursor %j", async (next) => {
    const { result, fetchJson } = await execute(
      blueprint([
        step({ pagination: { style: "cursor", nextPath: ["next"] } }),
      ]),
      [{ items: [{ id: "saved" }], next }],
    );
    expect(result).toMatchObject({ status: "complete", degraded: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it.each(["a&b=#+ %", "\uD83D\uDE00", "\uFFFD", "\0", " "])(
    "retains losslessly serializable cursor and parameter %j",
    async (value) => {
      const { result, fetchJson } = await execute(
        blueprint([
          step({
            pagination: { style: "cursor", param: value, nextPath: ["next"] },
          }),
        ]),
        [
          { items: [{ id: "saved" }], next: value },
          { items: [], next: null },
        ],
      );
      expect(new URL(fetchJson.mock.calls[1][0]).searchParams.get(value)).toBe(
        value,
      );
      expect(result.status).toBe("complete");
    },
  );
});

describe("descriptor safety before I/O", () => {
  it.each(["\uD800", "page\uDC00", "\uD800x"])(
    "rejects lossy query names %j",
    async (param) => {
      const fetchJson = vi.fn();
      await expect(
        runReplay({
          blueprint: blueprint([
            step({ pagination: { style: "page", param } }),
          ]),
          allowedOrigins: [origin],
          fetchJson,
          emit: vi.fn(),
        }),
      ).rejects.toThrow(/pagination param/);
      expect(fetchJson).not.toHaveBeenCalled();
    },
  );
  for (const key of Object.keys(DEFAULT_BUDGETS)) {
    it.each([0, -1, 0.5, "1", false, {}, [], NaN, Infinity])(
      `rejects explicit restrictive malformed ${key}: %j`,
      async (value) => {
        const fetchJson = vi.fn();
        await expect(
          runReplay({
            blueprint: blueprint([step()], { [key]: value }),
            allowedOrigins: [origin],
            fetchJson,
            emit: vi.fn(),
          }),
        ).rejects.toThrow(/budget/);
        expect(fetchJson).not.toHaveBeenCalled();
      },
    );
    it.each([undefined, null, HARD_BUDGETS[key] + 1])(
      `retains legacy absent or oversized ${key}: %j`,
      async (value) => {
        const { result } = await execute(
          blueprint([step()], { [key]: value }),
          [{ items: [] }],
        );
        expect(result.status).toBe("empty");
      },
    );
  }
  it("explicitly configures an empty test selection to fail", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(pkg.scripts.test).toContain("--passWithNoTests=false");
  });
});

describe("fan-out bounded work and exact exhaustion", () => {
  const fanout = () => [
    step({ collectAs: "parents" }),
    step({
      id: "children",
      template: "/parents/:id",
      forEach: "parents",
      collectAs: "children",
    }),
  ];
  it.each([1, 2])(
    "does not invent truncation after %i final children at the exact global cap",
    async (size) => {
      const parents = Array.from({ length: size }, (_, id) => ({ id }));
      const { result, fetchJson } = await execute(
        blueprint(fanout(), { maxPages: size + 1 }),
        [
          { items: parents },
          ...parents.map(({ id }) => ({ items: [{ id: `c${id}` }] })),
        ],
      );
      expect(result).toMatchObject({
        status: "complete",
        truncated: false,
        truncationReasons: [],
      });
      expect(fetchJson).toHaveBeenCalledTimes(size + 1);
    },
  );
  it("reports a budget only when an additional parent needs a request", async () => {
    const { result, fetchJson } = await execute(
      blueprint(fanout(), { maxPages: 2 }),
      [{ items: [{ id: 1 }, { id: 2 }] }, { items: [] }],
    );
    expect(result).toMatchObject({
      status: "partial",
      truncationReasons: ["budget"],
    });
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });
  it.each([100, 200])(
    "avoids recopying accumulated child IDs after the per-step cap (%i parents)",
    async (size) => {
      const NativeSet = globalThis.Set;
      let copied = 0;
      class CountingSet extends NativeSet {
        constructor(input) {
          if (input) copied += [...input].length;
          super(input);
        }
      }
      const rows = Array.from({ length: size }, (_, id) => ({ id }));
      let walk;
      vi.stubGlobal("Set", CountingSet);
      try {
        walk = await execute(blueprint(fanout(), { maxPagesPerStep: 1 }), [
          { items: rows },
          { items: rows },
        ]);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(walk.fetchJson).toHaveBeenCalledTimes(2);
      expect(walk.result.truncationReasons).toEqual(["budget"]);
      expect(copied).toBeLessThan(size * 3);
    },
  );
  it("preserves insertion order and deduplicates IDs across collection contexts", async () => {
    const { result, fetchJson } = await execute(
      blueprint([
        ...fanout(),
        step({ id: "leaves", template: "/children/:id", forEach: "children" }),
      ]),
      [
        { items: [{ id: "p1" }, { id: "p2" }] },
        { items: [{ id: "b" }, { id: "a" }] },
        { items: [{ id: "a" }, { id: "c" }] },
        { items: [] },
        { items: [] },
        { items: [] },
      ],
    );
    expect(
      fetchJson.mock.calls.slice(3).map(([url]) => new URL(url).pathname),
    ).toEqual(["/children/b", "/children/a", "/children/c"]);
    expect(result).toMatchObject({ status: "complete", entities: 6 });
  });
});
