import { describe, it, expect, vi } from "vitest";
// report() is fire-and-forget, so "did the post happen" is only observable once
// the microtask queue has drained — not after a fixed number of ticks.
const drain = () => new Promise((r) => setTimeout(r, 0));
import {
  createProgressReporter,
  PROGRESS_MAX_ENTRIES,
  PROGRESS_MAX_ENTITY_TYPE,
  PROGRESS_MAX_INTENT_ID,
  PROGRESS_MAX_DEVICE_ID,
  PROGRESS_MAX_ERROR,
  PROGRESS_MIN_INTERVAL_MS,
} from "../shared/progress.js";

// Coverage of the /api/scout/progress adapter. Three properties matter, and each
// maps to a way the feature can hurt rather than help:
//
//   BOUNDED  — the engine's onProgress fires per emitted batch, far above the
//              backend's 240/min throttle. An unthrottled or oversized report is
//              429'd or 400'd and the whole series is lost.
//   MONOTONE — count_committed is a high-water mark. A count that goes backwards
//              reads to a watching coach as records being deleted.
//   ADVISORY — a progress failure must never fail an import. Nothing here may
//              throw or reject.

function makeReporter(overrides = {}) {
  const posts = [];
  let clock = 0;
  const reporter = createProgressReporter({
    postProgress: async (body) => {
      posts.push(body);
    },
    intentId: "imp-1",
    deviceId: "dev-1",
    now: () => clock,
    ...overrides,
  });
  return {
    reporter,
    posts,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const rows = (...pairs) =>
  pairs.map(([entityType, sent]) => ({ entityType, sent }));

describe("progress reporter — DTO shape", () => {
  it("posts the exact ScoutProgressDto field names (snake_case body, camelCase deviceId)", async () => {
    const { reporter, posts } = makeReporter();
    await reporter.flush(rows(["client", 3]));
    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0]).sort()).toEqual([
      "deviceId",
      "intent_id",
      "progress",
    ]);
    expect(posts[0].intent_id).toBe("imp-1");
    expect(posts[0].deviceId).toBe("dev-1");
  });

  it("posts each entry with entity_type, count_committed and total_estimated", async () => {
    const { reporter, posts } = makeReporter();
    await reporter.flush(rows(["client", 3]));
    expect(posts[0].progress).toEqual([
      { entity_type: "client", count_committed: 3, total_estimated: 3 },
    ]);
  });

  it("omits lastError entirely when there is none (an optional field, not an empty string)", async () => {
    const { reporter, posts } = makeReporter();
    await reporter.flush(rows(["client", 1]));
    expect("lastError" in posts[0]).toBe(false);
  });

  it("includes lastError when supplied", async () => {
    const { reporter, posts } = makeReporter();
    await reporter.flush(rows(["client", 1]), "some pages were skipped");
    expect(posts[0].lastError).toBe("some pages were skipped");
  });

  it("emits integer counts only, never a float or NaN", async () => {
    const { reporter, posts } = makeReporter();
    await reporter.flush([
      { entityType: "client", sent: 2.5 },
      { entityType: "note", sent: Number.NaN },
    ]);
    for (const entry of posts[0].progress) {
      expect(Number.isInteger(entry.count_committed)).toBe(true);
      expect(entry.count_committed).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("progress reporter — monotone counts", () => {
  it("keeps a high-water mark so a lower later count never regresses the report", async () => {
    const { reporter, posts, advance } = makeReporter();
    await reporter.flush(rows(["client", 10]));
    advance(PROGRESS_MIN_INTERVAL_MS);
    await reporter.flush(rows(["client", 4]));
    expect(posts[1].progress[0].count_committed).toBe(10);
  });

  it("advances when the count genuinely grows", async () => {
    const { reporter, posts, advance } = makeReporter();
    await reporter.flush(rows(["client", 4]));
    advance(PROGRESS_MIN_INTERVAL_MS);
    await reporter.flush(rows(["client", 9]));
    expect(posts.map((p) => p.progress[0].count_committed)).toEqual([4, 9]);
  });

  it("tracks each entity type independently", async () => {
    const { reporter, posts, advance } = makeReporter();
    await reporter.flush(rows(["client", 5], ["note", 2]));
    advance(PROGRESS_MIN_INTERVAL_MS);
    await reporter.flush(rows(["client", 1], ["note", 7]));
    expect(posts[1].progress).toEqual([
      { entity_type: "client", count_committed: 5, total_estimated: 5 },
      { entity_type: "note", count_committed: 7, total_estimated: 7 },
    ]);
  });

  it("is monotone across an arbitrary jittering sequence", async () => {
    const { reporter, posts, advance } = makeReporter();
    for (const n of [1, 5, 3, 9, 2, 9, 12, 0]) {
      await reporter.flush(rows(["client", n]));
      advance(PROGRESS_MIN_INTERVAL_MS);
    }
    const counts = posts.map((p) => p.progress[0].count_committed);
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
    expect(counts.at(-1)).toBe(12);
  });

  it("treats a negative or missing sent value as 0 without lowering the mark", async () => {
    const { reporter, posts, advance } = makeReporter();
    await reporter.flush(rows(["client", 6]));
    advance(PROGRESS_MIN_INTERVAL_MS);
    await reporter.flush([
      { entityType: "client", sent: -3 },
      { entityType: "client" },
    ]);
    expect(posts[1].progress[0].count_committed).toBe(6);
  });
});

describe("progress reporter — bounded rate", () => {
  it("posts the first report immediately", () => {
    const { reporter, posts } = makeReporter();
    reporter.report(rows(["client", 1]));
    expect(posts).toHaveLength(1);
  });

  it("suppresses reports inside the minimum interval", async () => {
    const { reporter, posts, advance } = makeReporter();
    reporter.report(rows(["client", 1]));
    await Promise.resolve();
    advance(PROGRESS_MIN_INTERVAL_MS - 1);
    reporter.report(rows(["client", 2]));
    expect(posts).toHaveLength(1);
  });

  it("allows the next report once the interval has elapsed", async () => {
    const { reporter, posts, advance } = makeReporter();
    reporter.report(rows(["client", 1]));
    await drain();
    advance(PROGRESS_MIN_INTERVAL_MS);
    reporter.report(rows(["client", 2]));
    await drain();
    expect(posts).toHaveLength(2);
  });

  it("stays far under the backend's 240/min throttle under a hot emit loop", async () => {
    const { reporter, posts, advance } = makeReporter();
    // 600 batches spread over one simulated minute.
    for (let i = 1; i <= 600; i += 1) {
      reporter.report(rows(["client", i]));
      await Promise.resolve();
      advance(100);
    }
    // One per PROGRESS_MIN_INTERVAL_MS over 60s is ~60. Asserting the real
    // ceiling (not merely the backend's 240) means a weakened throttle fails
    // here rather than only showing up as production 429s.
    expect(posts.length).toBeLessThanOrEqual(61);
    expect(posts.length).toBeGreaterThan(0);
  });

  it("never runs two posts concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const { reporter, advance } = makeReporter({
      postProgress: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
      },
    });
    reporter.report(rows(["client", 1]));
    advance(PROGRESS_MIN_INTERVAL_MS * 5);
    reporter.report(rows(["client", 2]));
    advance(PROGRESS_MIN_INTERVAL_MS * 5);
    reporter.report(rows(["client", 3]));
    release();
    await Promise.resolve();
    expect(maxInFlight).toBe(1);
  });

  it("flush bypasses the interval so the terminal counts always land", async () => {
    const { reporter, posts } = makeReporter();
    reporter.report(rows(["client", 1]));
    await Promise.resolve();
    const sent = await reporter.flush(rows(["client", 2]));
    expect(sent).toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[1].progress[0].count_committed).toBe(2);
  });

  it("flush waits for an in-flight report instead of being dropped", async () => {
    // The terminal flush carries the run's final counts. Skipping it because a
    // throttled report was still outstanding would leave the backend's last
    // view of the run permanently stale — a silent undercount of the import.
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const posts = [];
    let first = true;
    const { reporter } = makeReporter({
      postProgress: async (body) => {
        posts.push(body);
        if (first) {
          first = false;
          await gate;
        }
      },
    });
    reporter.report(rows(["client", 1]));
    await Promise.resolve();
    expect(posts).toHaveLength(1);
    const flushed = reporter.flush(rows(["client", 9]));
    release();
    await expect(flushed).resolves.toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[1].progress[0].count_committed).toBe(9);
  });

  it("a failed in-flight report does not stop the terminal flush from landing", async () => {
    const posts = [];
    let first = true;
    const { reporter } = makeReporter({
      postProgress: async (body) => {
        posts.push(body);
        if (first) {
          first = false;
          throw new Error("progress 429");
        }
      },
    });
    reporter.report(rows(["client", 1]));
    await Promise.resolve();
    await expect(reporter.flush(rows(["client", 5]))).resolves.toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[1].progress[0].count_committed).toBe(5);
  });
});

describe("progress reporter — bounded payload", () => {
  it("caps the entry count at the DTO's ArrayMaxSize", async () => {
    const { reporter, posts } = makeReporter();
    const many = [];
    for (let i = 0; i < PROGRESS_MAX_ENTRIES + 25; i += 1) {
      many.push({ entityType: `type-${i}`, sent: 1 });
    }
    await reporter.flush(many);
    expect(posts[0].progress).toHaveLength(PROGRESS_MAX_ENTRIES);
  });

  it("clamps an over-long entity type", async () => {
    const { reporter, posts } = makeReporter();
    await reporter.flush([{ entityType: "e".repeat(500), sent: 1 }]);
    expect(posts[0].progress[0].entity_type).toHaveLength(
      PROGRESS_MAX_ENTITY_TYPE,
    );
  });

  it("clamps an over-long intent id", async () => {
    const { reporter, posts } = makeReporter({ intentId: "i".repeat(500) });
    await reporter.flush(rows(["client", 1]));
    expect(posts[0].intent_id).toHaveLength(PROGRESS_MAX_INTENT_ID);
  });

  it("clamps an over-long device id", async () => {
    const { reporter, posts } = makeReporter({ deviceId: "d".repeat(500) });
    await reporter.flush(rows(["client", 1]));
    expect(posts[0].deviceId).toHaveLength(PROGRESS_MAX_DEVICE_ID);
  });

  it("clamps an over-long lastError", async () => {
    const { reporter, posts } = makeReporter();
    await reporter.flush(rows(["client", 1]), "x".repeat(9000));
    expect(posts[0].lastError).toHaveLength(PROGRESS_MAX_ERROR);
  });
});

describe("progress reporter — advisory only, never fails an import", () => {
  it("swallows a rejected post and reports false", async () => {
    const { reporter } = makeReporter({
      postProgress: async () => {
        throw new Error("progress 500");
      },
    });
    await expect(reporter.flush(rows(["client", 1]))).resolves.toBe(false);
  });

  it("keeps working after a failed post", async () => {
    const posts = [];
    let fail = true;
    let clock = 0;
    const reporter = createProgressReporter({
      postProgress: async (body) => {
        if (fail) {
          throw new Error("progress 500");
        }
        posts.push(body);
      },
      intentId: "imp-1",
      deviceId: "dev-1",
      now: () => clock,
    });
    await reporter.flush(rows(["client", 1]));
    fail = false;
    clock += PROGRESS_MIN_INTERVAL_MS;
    await reporter.flush(rows(["client", 4]));
    expect(posts).toHaveLength(1);
    expect(posts[0].progress[0].count_committed).toBe(4);
  });

  it("report() returns synchronously and never throws on a rejecting transport", () => {
    const { reporter } = makeReporter({
      postProgress: async () => {
        throw new Error("nope");
      },
    });
    expect(() => reporter.report(rows(["client", 1]))).not.toThrow();
  });

  it("stays silent rather than posting an invalid body when the device id is missing", async () => {
    const { reporter, posts } = makeReporter({ deviceId: "" });
    await expect(reporter.flush(rows(["client", 1]))).resolves.toBe(false);
    expect(posts).toHaveLength(0);
  });

  it("stays silent when the intent id is missing", async () => {
    const { reporter, posts } = makeReporter({ intentId: "" });
    await expect(reporter.flush(rows(["client", 1]))).resolves.toBe(false);
    expect(posts).toHaveLength(0);
  });

  it("posts nothing when there is no progress to report", async () => {
    const { reporter, posts } = makeReporter();
    await expect(reporter.flush([])).resolves.toBe(false);
    expect(posts).toHaveLength(0);
  });

  it.each([
    ["undefined rows", undefined],
    ["null rows", null],
    ["a non-array", { entityType: "client", sent: 1 }],
    ["rows of junk", [null, 3, "client", { sent: 1 }, { entityType: "" }]],
  ])("ignores %s without throwing", async (_label, input) => {
    const { reporter, posts } = makeReporter();
    await expect(reporter.flush(input)).resolves.toBe(false);
    expect(posts).toHaveLength(0);
  });

  it("does not leak token material or URLs — the body carries only ids and counts", async () => {
    const { reporter, posts } = makeReporter();
    await reporter.flush(
      rows(["client", 2]),
      "import failed — source responded 429",
    );
    const serialized = JSON.stringify(posts[0]);
    expect(serialized).not.toMatch(/Bearer|https?:\/\//);
  });
});

describe("progress reporter — postProgress call discipline", () => {
  it("hands the transport a plain serializable object", async () => {
    const postProgress = vi.fn().mockResolvedValue(undefined);
    const reporter = createProgressReporter({
      postProgress,
      intentId: "imp-1",
      deviceId: "dev-1",
    });
    await reporter.flush(rows(["client", 1]));
    const [body] = postProgress.mock.calls[0];
    expect(() => JSON.parse(JSON.stringify(body))).not.toThrow();
  });

  it("respects a caller-supplied minimum interval", async () => {
    const { reporter, posts, advance } = makeReporter({ minIntervalMs: 50 });
    reporter.report(rows(["client", 1]));
    await drain();
    advance(50);
    reporter.report(rows(["client", 2]));
    await drain();
    expect(posts).toHaveLength(2);
  });
});
