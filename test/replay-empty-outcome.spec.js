import { describe, it, expect, vi } from "vitest";
import { runReplay } from "../shared/replay/engine.js";

// The zero-entity false-completion defect.
//
// A walk where every request returned 200 and every page parsed, but which
// yielded zero entities, used to report status "complete". Nothing in the run
// looks wrong, so the extension told the coach their import succeeded — when the
// overwhelmingly likely cause is adapter drift (renamed itemsPath, moved
// endpoint, changed response shape). "Your import completed, 0 records" is
// indistinguishable to a coach from "you have no clients", and it is the failure
// mode most likely to silently lose an entire migration.
//
// The fix: a distinct "empty" terminal status. These tests pin that it fires on
// exactly the clean-and-zero case and does NOT swallow or displace any other
// outcome — degraded, truncated and populated runs must classify as before.

const ORIGIN = "https://src.example";
const ALLOWED = [ORIGIN];

function blueprint(steps, budgets) {
  return {
    platform: "test",
    apiBase: `${ORIGIN}/api`,
    rateLimitMs: 0,
    steps,
    budgets: {
      maxPages: 50,
      maxPagesPerStep: 20,
      maxEntities: 500,
      requestTimeoutMs: 1000,
      ...budgets,
    },
  };
}

const ONE_STEP = [
  {
    id: "things",
    entityType: "thing",
    template: "/things",
    itemsPath: ["items"],
    idField: "id",
  },
];

function run(fetchJson, { steps = ONE_STEP, budgets, emit } = {}) {
  return runReplay({
    blueprint: blueprint(steps, budgets),
    fetchJson,
    emit: emit ?? (() => {}),
    sleep: () => Promise.resolve(),
    allowedOrigins: ALLOWED,
  });
}

function httpError(status) {
  const err = new Error(`source ${status}`);
  err.name = "HttpError";
  err.status = status;
  return err;
}

describe("runReplay — a clean zero-entity walk reports empty, never complete", () => {
  it("classifies an empty item list as empty", async () => {
    const result = await run(vi.fn().mockResolvedValue({ items: [] }));
    expect(result.status).toBe("empty");
    expect(result.status).not.toBe("complete");
    expect(result.entities).toBe(0);
  });

  it("classifies a drifted response shape (itemsPath no longer resolves) as empty", async () => {
    // The classic drift: the source renamed `items` to `data`. Every request
    // is a 200, nothing is malformed, and zero entities come out.
    const result = await run(
      vi.fn().mockResolvedValue({ data: [{ id: "a" }, { id: "b" }] }),
    );
    expect(result.status).toBe("empty");
    expect(result.degraded).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("reports empty as NOT degraded and NOT truncated — nothing actually errored", async () => {
    const result = await run(vi.fn().mockResolvedValue({ items: [] }));
    expect(result.degraded).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.lastSkipStatus).toBeNull();
  });

  it("still counts the pages it walked so an empty outcome is diagnosable", async () => {
    const result = await run(vi.fn().mockResolvedValue({ items: [] }));
    expect(result.pages).toBeGreaterThan(0);
  });

  it("never invokes emit on an empty walk", async () => {
    const emit = vi.fn();
    const result = await run(vi.fn().mockResolvedValue({ items: [] }), {
      emit,
    });
    expect(result.status).toBe("empty");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("runReplay — empty does not displace the other terminal outcomes", () => {
  it("a populated clean walk is still complete", async () => {
    const result = await run(
      vi.fn().mockResolvedValue({ items: [{ id: "a" }] }),
    );
    expect(result.status).toBe("complete");
    expect(result.entities).toBe(1);
  });

  it("zero entities WITH skipped pages is failed, not empty", async () => {
    const result = await run(vi.fn().mockRejectedValue(httpError(404)));
    expect(result.status).toBe("failed");
    expect(result.degraded).toBe(true);
  });

  it("some entities WITH skipped pages is still partial, not empty", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: "a" }] })
      .mockRejectedValue(httpError(404));
    const steps = [
      {
        id: "a",
        entityType: "alpha",
        template: "/a",
        itemsPath: ["items"],
        idField: "id",
      },
      {
        id: "b",
        entityType: "beta",
        template: "/b",
        itemsPath: ["items"],
        idField: "id",
      },
    ];
    const result = await run(fetchJson, { steps });
    expect(result.status).toBe("partial");
    expect(result.entities).toBe(1);
  });

  it("a truncated walk that emitted nothing is partial, not empty", async () => {
    // The first step spends the entire page budget on an empty page, so the
    // second step is cut off before it runs: truncated with zero entities.
    // That is a budget artefact, not an adapter-drift signal, so it must not
    // read as empty.
    const steps = [
      {
        id: "a",
        entityType: "alpha",
        template: "/a",
        itemsPath: ["items"],
        idField: "id",
      },
      {
        id: "b",
        entityType: "beta",
        template: "/b",
        itemsPath: ["items"],
        idField: "id",
      },
    ];
    const result = await run(vi.fn().mockResolvedValue({ items: [] }), {
      steps,
      budgets: { maxPages: 1 },
    });
    expect(result.truncated).toBe(true);
    expect(result.entities).toBe(0);
    expect(result.status).toBe("partial");
  });

  it("a cancelled walk is cancelled, not empty", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runReplay({
      blueprint: blueprint(ONE_STEP),
      fetchJson: vi.fn().mockResolvedValue({ items: [] }),
      emit: () => {},
      sleep: () => Promise.resolve(),
      signal: controller.signal,
      allowedOrigins: ALLOWED,
    });
    expect(result.status).toBe("cancelled");
  });
});
