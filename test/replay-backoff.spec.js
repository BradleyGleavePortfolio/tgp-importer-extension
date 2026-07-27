import { describe, it, expect, vi } from "vitest";
import { runReplay, backoffDelayMs, MAX_BACKOFF_MS, DEFAULT_BACKOFF_BASE_MS } from "../shared/replay/engine.js";

// Coverage of 429 handling and retry backoff in the replay engine.
//
// Before this, a 429 was classified non-retryable (only >=500 was) AND retries
// fired with no delay at all — so a rate-limited source lost the page outright,
// and a 5xx blip burned all three attempts inside a single event-loop turn. Both
// silently drop data.
//
// Backoff is deliberately jitter-free so the delay sequence is an exact,
// assertable property rather than a range. `sleep` is injected, so these tests
// pin the real numbers without spending real time.

const ORIGIN = "https://src.example";
const ALLOWED = [ORIGIN];

function blueprint(steps) {
    return {
        platform: "test",
        apiBase: `${ORIGIN}/api`,
        rateLimitMs: 0,
        steps,
        budgets: { maxPages: 50, maxPagesPerStep: 20, maxEntities: 500, requestTimeoutMs: 1000 },
    };
}

const ONE_STEP = [{ id: "things", entityType: "thing", template: "/things", itemsPath: ["items"], idField: "id" }];

function httpError(status, extra = {}) {
    const err = new Error(`source ${status}`);
    err.name = "HttpError";
    err.status = status;
    return Object.assign(err, extra);
}

// Run with a recording sleep so the exact delay sequence is observable.
async function runWith(fetchJson, overrides = {}) {
    const slept = [];
    const emitted = [];
    const result = await runReplay({
        blueprint: blueprint(ONE_STEP),
        fetchJson,
        emit: (entityType, batch) => { emitted.push([entityType, batch]); },
        sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
        allowedOrigins: ALLOWED,
        ...overrides,
    });
    return { result, slept, emitted };
}

describe("backoffDelayMs — deterministic exponential schedule", () => {
    it("doubles per attempt from the default base", () => {
        const err = httpError(503);
        expect(backoffDelayMs(err, 1)).toBe(DEFAULT_BACKOFF_BASE_MS);
        expect(backoffDelayMs(err, 2)).toBe(DEFAULT_BACKOFF_BASE_MS * 2);
        expect(backoffDelayMs(err, 3)).toBe(DEFAULT_BACKOFF_BASE_MS * 4);
    });

    it("honours a caller-supplied base", () => {
        expect(backoffDelayMs(httpError(503), 3, 10)).toBe(40);
    });

    it("is a pure function of (err, attempt, base) — no jitter", () => {
        const err = httpError(503);
        const first = backoffDelayMs(err, 2);
        for (let i = 0; i < 20; i += 1) {
            expect(backoffDelayMs(err, 2)).toBe(first);
        }
    });

    it("caps the exponential growth at MAX_BACKOFF_MS", () => {
        expect(backoffDelayMs(httpError(503), 40)).toBe(MAX_BACKOFF_MS);
    });
});

describe("backoffDelayMs — Retry-After takes precedence, still bounded", () => {
    it("uses the server hint instead of the exponential value", () => {
        expect(backoffDelayMs(httpError(429, { retryAfterMs: 2500 }), 1)).toBe(2500);
    });

    it("honours a hint of 0 as retry-immediately", () => {
        expect(backoffDelayMs(httpError(429, { retryAfterMs: 0 }), 3)).toBe(0);
    });

    it("clamps an over-large hint to MAX_BACKOFF_MS", () => {
        expect(backoffDelayMs(httpError(429, { retryAfterMs: 10 * MAX_BACKOFF_MS }), 1)).toBe(MAX_BACKOFF_MS);
    });

    it.each([
        ["negative", -1000],
        ["NaN", Number.NaN],
        ["a string", "3000"],
        ["null", null],
    ])("ignores a %s hint and falls back to exponential backoff", (_label, retryAfterMs) => {
        expect(backoffDelayMs(httpError(429, { retryAfterMs }), 2)).toBe(DEFAULT_BACKOFF_BASE_MS * 2);
    });

    it("falls back to exponential backoff when no hint is present at all", () => {
        expect(backoffDelayMs(httpError(429), 1)).toBe(DEFAULT_BACKOFF_BASE_MS);
    });
});

describe("runReplay — a 429 is retried, not dropped", () => {
    it("recovers the page when the retry succeeds", async () => {
        const fetchJson = vi.fn()
            .mockRejectedValueOnce(httpError(429))
            .mockResolvedValueOnce({ items: [{ id: "a" }] });
        const { result, emitted } = await runWith(fetchJson);
        expect(fetchJson).toHaveBeenCalledTimes(2);
        expect(result.status).toBe("complete");
        expect(result.entities).toBe(1);
        expect(result.degraded).toBe(false);
        expect(emitted[0][1][0].sourceId).toBe("a");
    });

    it("waits the deterministic backoff before each retry", async () => {
        const fetchJson = vi.fn()
            .mockRejectedValueOnce(httpError(429))
            .mockRejectedValueOnce(httpError(429))
            .mockResolvedValueOnce({ items: [{ id: "a" }] });
        const { slept } = await runWith(fetchJson, { backoffBaseMs: 100 });
        expect(slept).toEqual([100, 200]);
    });

    it("prefers the source's Retry-After hint over its own schedule", async () => {
        const fetchJson = vi.fn()
            .mockRejectedValueOnce(httpError(429, { retryAfterMs: 1750 }))
            .mockResolvedValueOnce({ items: [{ id: "a" }] });
        const { slept } = await runWith(fetchJson, { backoffBaseMs: 100 });
        expect(slept).toEqual([1750]);
    });

    it("never sleeps longer than MAX_BACKOFF_MS however large the hint", async () => {
        const fetchJson = vi.fn()
            .mockRejectedValueOnce(httpError(429, { retryAfterMs: 86400000 }))
            .mockResolvedValueOnce({ items: [{ id: "a" }] });
        const { slept } = await runWith(fetchJson);
        expect(slept).toEqual([MAX_BACKOFF_MS]);
        expect(Math.max(...slept)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    });

    it("gives up after maxAttempts and reports a degraded run carrying the 429", async () => {
        const fetchJson = vi.fn().mockRejectedValue(httpError(429));
        const { result, slept } = await runWith(fetchJson, { backoffBaseMs: 100 });
        expect(fetchJson).toHaveBeenCalledTimes(3);
        expect(slept).toEqual([100, 200]); // no sleep after the final attempt
        expect(result.degraded).toBe(true);
        expect(result.lastSkipStatus).toBe(429);
        expect(result.status).toBe("failed");
    });

    it("still retries a 5xx with the same schedule", async () => {
        const fetchJson = vi.fn()
            .mockRejectedValueOnce(httpError(503))
            .mockResolvedValueOnce({ items: [{ id: "a" }] });
        const { result, slept } = await runWith(fetchJson, { backoffBaseMs: 100 });
        expect(slept).toEqual([100]);
        expect(result.status).toBe("complete");
    });

    it("does NOT retry or sleep on a non-429 4xx", async () => {
        const fetchJson = vi.fn().mockRejectedValue(httpError(404));
        const { result, slept } = await runWith(fetchJson);
        expect(fetchJson).toHaveBeenCalledTimes(1);
        expect(slept).toEqual([]);
        expect(result.lastSkipStatus).toBe(404);
    });

    it("does NOT retry or sleep on a malformed response", async () => {
        const err = new Error("bad json");
        err.name = "MalformedResponseError";
        const fetchJson = vi.fn().mockRejectedValue(err);
        const { result, slept } = await runWith(fetchJson);
        expect(fetchJson).toHaveBeenCalledTimes(1);
        expect(slept).toEqual([]);
        expect(result.lastSkipStatus).toBe("malformed");
    });
});
