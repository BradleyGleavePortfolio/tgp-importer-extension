import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout, isTimeout, DEFAULT_TIMEOUT_MS } from "../shared/net.js";

// Coverage of shared/net.js — the finite-timeout fetch wrapper every network
// call routes through. The invariants that matter: it resolves with the real
// response on success, propagates a genuine network rejection unchanged, rejects
// with a tagged TimeoutError when the deadline fires even if the underlying
// fetch never settles, hands the caller an AbortSignal, and always clears its
// timer so it cannot keep an MV3 worker alive.

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("fetchWithTimeout — success + passthrough", () => {
    it("resolves with the underlying response on success", async () => {
        const response = { ok: true, status: 200 };
        const fetchImpl = vi.fn().mockResolvedValue(response);
        await expect(fetchWithTimeout(fetchImpl, "https://x/y", { method: "POST" })).resolves.toBe(response);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe("https://x/y");
        expect(init.method).toBe("POST");
    });

    it("passes an AbortSignal into the fetch init so the request is cancellable", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
        await fetchWithTimeout(fetchImpl, "https://x/y");
        const [, init] = fetchImpl.mock.calls[0];
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal.aborted).toBe(false);
    });

    it("propagates a genuine network rejection unchanged (not a timeout)", async () => {
        const err = new Error("offline");
        const fetchImpl = vi.fn().mockRejectedValue(err);
        await expect(fetchWithTimeout(fetchImpl, "https://x/y")).rejects.toBe(err);
    });

    it("does not classify a real network error as a timeout", async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error("dns"));
        try {
            await fetchWithTimeout(fetchImpl, "https://x/y");
            throw new Error("should have rejected");
        }
        catch (err) {
            expect(isTimeout(err)).toBe(false);
        }
    });
});

describe("fetchWithTimeout — deadline", () => {
    it("rejects with a tagged TimeoutError when fetch never settles", async () => {
        vi.useFakeTimers();
        const fetchImpl = vi.fn(() => new Promise(() => {}));
        const p = fetchWithTimeout(fetchImpl, "https://x/y", {}, 1000);
        // Attach the rejection assertion BEFORE advancing: the deadline fires
        // inside advanceTimersByTimeAsync, so a handler must already be present or
        // the (correctly) rejected promise looks momentarily unhandled.
        const assertion = expect(p).rejects.toSatisfy((e) => isTimeout(e) && e.name === "TimeoutError");
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
    });

    it("aborts the in-flight request when the deadline fires", async () => {
        vi.useFakeTimers();
        let captured;
        const fetchImpl = vi.fn((_url, init) => {
            captured = init.signal;
            return new Promise(() => {});
        });
        const p = fetchWithTimeout(fetchImpl, "https://x/y", {}, 500);
        const settled = p.catch(() => {});
        await vi.advanceTimersByTimeAsync(500);
        await settled;
        expect(captured.aborted).toBe(true);
    });

    it("uses the default timeout when none is supplied", async () => {
        vi.useFakeTimers();
        const fetchImpl = vi.fn(() => new Promise(() => {}));
        const p = fetchWithTimeout(fetchImpl, "https://x/y");
        // Just short of the default: still pending.
        await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
        let settled = false;
        p.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        // Cross the default: rejects.
        await vi.advanceTimersByTimeAsync(1);
        await expect(p).rejects.toSatisfy(isTimeout);
    });

    it("clears its timer on success so no callback is left pending", async () => {
        vi.useFakeTimers();
        const clearSpy = vi.spyOn(globalThis, "clearTimeout");
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
        await fetchWithTimeout(fetchImpl, "https://x/y", {}, 1000);
        expect(clearSpy).toHaveBeenCalled();
    });
});

describe("isTimeout", () => {
    it("is true only for a TimeoutError-tagged Error", () => {
        const t = new Error("fetch_timeout");
        t.name = "TimeoutError";
        expect(isTimeout(t)).toBe(true);
        expect(isTimeout(new Error("other"))).toBe(false);
        expect(isTimeout("TimeoutError")).toBe(false);
        expect(isTimeout(null)).toBe(false);
        expect(isTimeout(undefined)).toBe(false);
    });
});
