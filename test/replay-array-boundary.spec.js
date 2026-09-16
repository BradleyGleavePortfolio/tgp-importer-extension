import { describe, it, expect, vi } from "vitest";
import { normalizeBlueprint } from "../shared/replay/blueprint.js";
import { runReplay } from "../shared/replay/engine.js";

const allowedOrigins = ["https://api.test"];
const step = { id: "s", entityType: "thing", template: "/things" };
function blueprint(steps) {
  return { platform: "test", apiBase: allowedOrigins[0], steps };
}

const sparsePaths = [
  { name: "one hole", path: Array(1) },
  { name: "all holes", path: Array(3) },
  { name: "leading hole", path: [, "items"] },
  { name: "middle hole", path: ["data", , "items"] },
  { name: "trailing hole", path: ["items", ,] },
];

describe("itemsPath rejects malformed present values before any side effect", () => {
  it.each([
    ...sparsePaths,
    { name: "string", path: "items" },
    { name: "number", path: 7 },
    { name: "record", path: {} },
    { name: "empty key", path: [""] },
    { name: "mixed entries", path: ["items", 5] },
  ])("rejects $name even in a later step", async ({ path }) => {
    const fetchJson = vi.fn(async () => ({ items: [{ id: "real" }] }));
    const emit = vi.fn();
    const input = blueprint([step, { ...step, id: "later", itemsPath: path }]);
    await expect(
      runReplay({ blueprint: input, allowedOrigins, fetchJson, emit }),
    ).rejects.toThrow(
      'blueprint step "later": itemsPath must be a string[] of non-empty strings',
    );
    expect(fetchJson).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each(sparsePaths)("does not mutate rejected $name", ({ path }) => {
    const before = Object.getOwnPropertyDescriptors(path);
    expect(() =>
      normalizeBlueprint(blueprint([{ ...step, itemsPath: path }]), {
        allowedOrigins,
      }),
    ).toThrow(/itemsPath must be/);
    expect(Object.getOwnPropertyDescriptors(path)).toEqual(before);
  });

  it.each([
    { name: "omitted", fields: {} },
    { name: "undefined", fields: { itemsPath: undefined } },
    { name: "null", fields: { itemsPath: null } },
    { name: "explicit empty root", fields: { itemsPath: [] } },
  ])("preserves $name as root-array extraction", async ({ fields }) => {
    const emit = vi.fn();
    const result = await runReplay({
      blueprint: blueprint([{ ...step, ...fields }]),
      allowedOrigins,
      fetchJson: async () => [{ id: "root" }],
      emit,
    });
    expect(result).toMatchObject({ status: "complete", entities: 1 });
    expect(emit).toHaveBeenCalledWith("thing", [
      expect.objectContaining({ sourceId: "root" }),
    ]);
  });

  it("copies a frozen valid nested path and normalizes idempotently", () => {
    const path = Object.freeze(["data", "items"]);
    const once = normalizeBlueprint(blueprint([{ ...step, itemsPath: path }]), {
      allowedOrigins,
    });
    const twice = normalizeBlueprint(once, { allowedOrigins });
    expect(once.steps[0].itemsPath).toEqual(["data", "items"]);
    expect(once.steps[0].itemsPath).not.toBe(path);
    expect(twice).toEqual(once);
    expect(twice.steps[0].itemsPath).not.toBe(once.steps[0].itemsPath);
  });
});

describe("sparse steps produce a blueprint contract error, not a raw TypeError", () => {
  it.each([
    { name: "all holes", steps: Array(2) },
    { name: "leading hole", steps: [, step] },
    { name: "middle hole", steps: [step, , { ...step, id: "last" }] },
    { name: "late hole", steps: [step, ,] },
  ])("rejects $name before any request or emission", async ({ steps }) => {
    const before = Object.getOwnPropertyDescriptors(steps);
    const fetchJson = vi.fn();
    const emit = vi.fn();
    await expect(
      runReplay({
        blueprint: blueprint(steps),
        allowedOrigins,
        fetchJson,
        emit,
      }),
    ).rejects.toThrow(new Error("blueprint step must be an object"));
    expect(fetchJson).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptors(steps)).toEqual(before);
  });
});
