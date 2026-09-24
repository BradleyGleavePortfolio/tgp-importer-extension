import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  discardBody,
  fetchWithTimeout,
  readBoundedJson,
  isTimeout,
  DEFAULT_TIMEOUT_MS,
  MAX_AUTH_BODY_BYTES,
} from "../shared/net.js";
import { redeemPairingCode } from "../shared/pairing.js";

// S4-R2-A-01 regression: the authentication paths (pair redeem, token refresh)
// used to await fetchWithTimeout only until HEADERS arrived and then parsed the
// body outside the deadline. A response whose JSON prefix arrives but whose
// stream never closes left the coach's single pairing submit and every
// coalesced refresh caller pending until browser teardown, and a later
// clear + re-establish joined the stale in-flight refresh.
//
// These tests use REAL Response objects on open ReadableStreams (not a fetch
// that never resolves) so they exercise body consumption, and fake timers so
// the 15 s deadline is deterministic.

const REFRESH_KEY = "tgp_refresh_token";
const TIMEOUT_COPY = "That took too long. Check your connection and try again.";
const enc = new TextEncoder();

// Headers 200, valid JSON prefix, stream never closes.
function stalledResponse(status = 200, cancel = undefined) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode('{"access_token":'));
      },
      cancel,
    }),
    { status },
  );
}
function streamed(text, status = 200) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(text));
        controller.close();
      },
    }),
    { status },
  );
}
// A stream whose remaining bytes arrive later — the "body completes AFTER the
// deadline" case. Once the deadline cancels the stream, late bytes are refused.
function lateResponse() {
  let ctl;
  const state = { cancelled: false, lateBytesAccepted: false };
  const res = new Response(
    new ReadableStream({
      start(controller) {
        ctl = controller;
        controller.enqueue(enc.encode('{"access_token":'));
      },
      cancel() {
        state.cancelled = true;
      },
    }),
    { status: 200 },
  );
  return {
    res,
    state,
    finish(rest) {
      try {
        ctl.enqueue(enc.encode(rest));
        ctl.close();
        state.lateBytesAccepted = true;
      } catch {
        state.lateBytesAccepted = false;
      }
    },
  };
}
function settleTracker(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(
    (v) => {
      state.settled = true;
      state.value = v;
    },
    (e) => {
      state.settled = true;
      state.error = e;
    },
  );
  return state;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchWithTimeout consumer + readBoundedJson", () => {
  it("the deadline covers body consumption inside the consumer", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => stalledResponse());
    const p = fetchWithTimeout(
      fetchImpl,
      "https://x/y",
      {},
      1000,
      (response, signal) => readBoundedJson(response, signal),
    );
    const assertion = expect(p).rejects.toSatisfy(isTimeout);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("also bounds the non-stream response.json() fallback", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    const p = fetchWithTimeout(
      fetchImpl,
      "https://x/y",
      {},
      1000,
      (response, signal) => readBoundedJson(response, signal),
    );
    const assertion = expect(p).rejects.toSatisfy(isTimeout);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("a deadline abort releases the reader even if stream cancel hangs", async () => {
    vi.useFakeTimers();
    const response = stalledResponse(200, () => new Promise(() => {}));
    const fetchImpl = vi.fn(async () => response);
    let consumerState = settleTracker(Promise.reject(new Error("unset")));
    const p = fetchWithTimeout(
      fetchImpl,
      "https://x/y",
      {},
      1000,
      (res, signal) => {
        const inner = readBoundedJson(res, signal);
        consumerState = settleTracker(inner);
        return inner;
      },
    );
    const assertion = expect(p).rejects.toSatisfy(isTimeout);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    await vi.advanceTimersByTimeAsync(0);
    expect(consumerState.settled).toBe(true);
    expect(consumerState.error).toBeInstanceOf(Error);
    expect(consumerState.error.name).toBe("BodyError");
    expect(response.body.locked).toBe(false);
  });

  it("a caller abort mid-body rejects AbortError and releases the stream", async () => {
    const response = stalledResponse();
    const ac = new AbortController();
    const p = fetchWithTimeout(
      async () => response,
      "https://x/y",
      { signal: ac.signal },
      60000,
      (res, signal) => readBoundedJson(res, signal),
    );
    const assertion = expect(p).rejects.toSatisfy(
      (e) => e instanceof Error && e.name === "AbortError",
    );
    await Promise.resolve();
    ac.abort();
    await assertion;
    await new Promise((r) => setTimeout(r, 0));
    expect(response.body.locked).toBe(false);
  });

  it("rejects oversized bodies with a tagged BodyError carrying no bytes", async () => {
    const secret = "PRIVATE_RESPONSE_BODY";
    const big = JSON.stringify({
      access_token: secret + "x".repeat(MAX_AUTH_BODY_BYTES),
    });
    const response = streamed(big);
    await expect(readBoundedJson(response)).rejects.toSatisfy(
      (e) =>
        e instanceof Error &&
        e.name === "BodyError" &&
        !e.message.includes(secret),
    );
    expect(response.body.locked).toBe(false);
  });

  it("rejects malformed bodies with a BodyError carrying no bytes", async () => {
    const response = streamed("<html>PRIVATE</html>");
    await expect(readBoundedJson(response)).rejects.toSatisfy(
      (e) => e.name === "BodyError" && !e.message.includes("PRIVATE"),
    );
  });

  it("discardBody requests cancellation without awaiting a hung cancel", async () => {
    let cancelRequested = false;
    const response = stalledResponse(401, () => {
      cancelRequested = true;
      return new Promise(() => {});
    });
    expect(discardBody(response)).toBe(true);
    expect(cancelRequested).toBe(true);
    expect(discardBody({ ok: false, status: 401 })).toBe(false);
    expect(discardBody(null)).toBe(false);
  });

  it("parses a well-formed streamed body", async () => {
    await expect(
      readBoundedJson(streamed('{"access_token":"a","refresh_token":"r"}')),
    ).resolves.toEqual({ access_token: "a", refresh_token: "r" });
  });
});

describe("pairing — body stall settles inside the deadline", () => {
  it("200 headers with a body that never ends -> timeout copy, no session", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let signal = new AbortController().signal;
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const p = redeemPairingCode("123456", {
      fetch: async (_url, init) => {
        signal = init.signal;
        return stalledResponse();
      },
      sendMessage,
    });
    const state = settleTracker(p);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect(state.value).toEqual({ ok: false, error: TIMEOUT_COPY });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
    const events = warn.mock.calls.map(([line]) => JSON.parse(line).event);
    expect(events).toContain("pair_timeout");
    expect(events).not.toContain("pair_body_parse_error");
  });

  it("non-2xx headers with a body that never ends also settles", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = redeemPairingCode("123456", {
      fetch: async () => stalledResponse(409),
      sendMessage: vi.fn(async () => ({ ok: true })),
    });
    const state = settleTracker(p);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(state.value).toEqual({ ok: false, error: TIMEOUT_COPY });
  });

  it("a body that completes AFTER the deadline never establishes a session", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const late = lateResponse();
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const p = redeemPairingCode("123456", {
      fetch: async () => late.res,
      sendMessage,
    });
    const state = settleTracker(p);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(state.value).toEqual({ ok: false, error: TIMEOUT_COPY });
    // The deadline cancelled the body stream, so late bytes are refused.
    expect(late.state.cancelled).toBe(true);
    late.finish('"A","refresh_token":"R"}');
    await vi.advanceTimersByTimeAsync(10);
    expect(late.state.lateBytesAccepted).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("a non-stream body that resolves AFTER the deadline never establishes a session", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    /** @type {(value: unknown) => void} */
    let releaseJson = () => {};
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const p = redeemPairingCode("123456", {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((r) => {
            releaseJson = r;
          }),
      }),
      sendMessage,
    });
    const state = settleTracker(p);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(state.value).toEqual({ ok: false, error: TIMEOUT_COPY });
    releaseJson({ access_token: "A", refresh_token: "R" });
    await vi.advanceTimersByTimeAsync(10);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("oversized 200 body -> unexpected response, token never forwarded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const res = await redeemPairingCode("123456", {
      fetch: async () =>
        streamed(
          JSON.stringify({
            access_token: "x".repeat(MAX_AUTH_BODY_BYTES + 1),
            refresh_token: "y",
          }),
        ),
      sendMessage,
    });
    expect(res).toEqual({ ok: false, error: "Unexpected pairing response." });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("a well-formed streamed body still pairs and forwards only via session_established", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const res = await redeemPairingCode("123456", {
      fetch: async () =>
        streamed(
          JSON.stringify({
            access_token: "A",
            refresh_token: "R",
            chosen_platform: "truecoach",
          }),
        ),
      sendMessage,
    });
    expect(res).toEqual({ ok: true, chosenPlatform: "truecoach" });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      kind: "session_established",
      accessToken: "A",
      refreshToken: "R",
    });
  });
});

describe("session refresh — body stall, recovery and epoch isolation", () => {
  let store;
  let fetchImpl;
  let fetches;
  let mod;
  let warn;

  beforeEach(async () => {
    vi.resetModules();
    store = new Map([[REFRESH_KEY, "refresh-1"]]);
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
          set: async (obj) => {
            for (const [k, v] of Object.entries(obj)) store.set(k, v);
          },
          remove: async (key) => {
            store.delete(key);
          },
        },
      },
    });
    fetches = [];
    fetchImpl = async (_url, _init) => stalledResponse();
    vi.stubGlobal("fetch", async (url, init) => {
      fetches.push(JSON.parse(init.body).refresh_token);
      return fetchImpl(url, init);
    });
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mod = await import("../shared/session.js");
  });

  // Let the snapshot-under-lock resolve and the fetch fire.
  const settleMicrotasks = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };

  it("a refresh whose body never ends settles null at the deadline and keeps the stored token", async () => {
    vi.useFakeTimers();
    const state = settleTracker(mod.refreshAccessToken());
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect(state.value).toBeNull();
    expect(store.get(REFRESH_KEY)).toBe("refresh-1");
    const events = warn.mock.calls.map(([line]) => JSON.parse(line).event);
    expect(events).toContain("refresh_timeout");
    expect(events).not.toContain("refresh_body_parse_error");
    // Coalesced callers are released too: a fresh call does its own fetch.
    fetchImpl = async (_url, _init) =>
      streamed(JSON.stringify({ access_token: "access-after-timeout" }));
    await expect(mod.refreshAccessToken()).resolves.toBe(
      "access-after-timeout",
    );
    expect(fetches).toEqual(["refresh-1", "refresh-1"]);
  });

  it("a body that completes AFTER the deadline is never committed", async () => {
    vi.useFakeTimers();
    const late = lateResponse();
    fetchImpl = async (_url, _init) => late.res;
    const state = settleTracker(mod.refreshAccessToken());
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(state.value).toBeNull();
    expect(late.state.cancelled).toBe(true);
    late.finish('"LATE","refresh_token":"rotated-late"}');
    await vi.advanceTimersByTimeAsync(10);
    expect(late.state.lateBytesAccepted).toBe(false);
    expect(store.get(REFRESH_KEY)).toBe("refresh-1");
    // No access token was published: the next getAccessToken must refresh.
    fetchImpl = async (_url, _init) =>
      streamed(JSON.stringify({ access_token: "access-fresh" }));
    await expect(mod.getAccessToken()).resolves.toBe("access-fresh");
  });

  it("a non-stream refresh body that resolves AFTER the deadline is never committed", async () => {
    vi.useFakeTimers();
    /** @type {(value: unknown) => void} */
    let releaseJson = () => {};
    fetchImpl = async (_url, _init) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((r) => {
          releaseJson = r;
        }),
    });
    const state = settleTracker(mod.refreshAccessToken());
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(state.value).toBeNull();
    releaseJson({ access_token: "LATE", refresh_token: "rotated-late" });
    await vi.advanceTimersByTimeAsync(10);
    expect(store.get(REFRESH_KEY)).toBe("refresh-1");
    fetchImpl = async (_url, _init) =>
      streamed(JSON.stringify({ access_token: "access-fresh" }));
    await expect(mod.getAccessToken()).resolves.toBe("access-fresh");
  });

  it("clear + re-establish during a stalled refresh: the new session refreshes on its own and stale work cannot overwrite it", async () => {
    vi.useFakeTimers();
    await mod.establishSession("access-old", "refresh-old");
    const stale = settleTracker(mod.refreshAccessToken());
    await settleMicrotasks();
    expect(fetches).toEqual(["refresh-old"]);

    await mod.clearTokens();
    await mod.establishSession("access-new", "refresh-new");
    fetchImpl = async (_url, _init) =>
      streamed(
        JSON.stringify({
          access_token: "access-new-minted",
          refresh_token: "refresh-new-2",
        }),
      );
    await expect(mod.refreshAccessToken()).resolves.toBe("access-new-minted");
    expect(fetches).toEqual(["refresh-old", "refresh-new"]);
    expect(store.get(REFRESH_KEY)).toBe("refresh-new-2");
    expect(stale.settled).toBe(false);

    // The stale body's deadline fires afterwards: null, nothing overwritten.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(stale.settled).toBe(true);
    expect(stale.value).toBeNull();
    await expect(mod.getAccessToken()).resolves.toBe("access-new-minted");
    expect(store.get(REFRESH_KEY)).toBe("refresh-new-2");
  });

  it("a stale refresh that later SUCCEEDS after re-establish is still fenced", async () => {
    await mod.establishSession("access-e1", "refresh-e1");
    /** @type {(value: Response) => void} */
    let release = () => {};
    fetchImpl = (_url, _init) =>
      new Promise((r) => {
        release = r;
      });
    const staleP = mod.refreshAccessToken();
    await settleMicrotasks();
    await mod.clearTokens();
    await mod.establishSession("access-e2", "refresh-e2");
    release(
      streamed(
        JSON.stringify({
          access_token: "RESURRECT",
          refresh_token: "refresh-resurrect",
        }),
      ),
    );
    await expect(staleP).resolves.toBeNull();
    await expect(mod.getAccessToken()).resolves.toBe("access-e2");
    expect(store.get(REFRESH_KEY)).toBe("refresh-e2");
  });

  it("the stale refresh's completion cannot clear the NEW session's in-flight slot", async () => {
    vi.useFakeTimers();
    await mod.establishSession("access-old", "refresh-old");
    const stale = settleTracker(mod.refreshAccessToken());
    await settleMicrotasks();
    // The stale deadline is 1 s older than the new session's deadline.
    await vi.advanceTimersByTimeAsync(1000);
    await mod.clearTokens();
    await mod.establishSession("access-new", "refresh-new");
    // New-session refresh parks on the network (headers not yet in).
    /** @type {(value: Response) => void} */
    let releaseNew = () => {};
    fetchImpl = (_url, _init) =>
      new Promise((r) => {
        releaseNew = r;
      });
    const fresh = settleTracker(mod.refreshAccessToken());
    await settleMicrotasks();
    expect(fetches).toEqual(["refresh-old", "refresh-new"]);
    // Stale deadline fires while the new refresh is still in flight.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1000);
    expect(stale.settled).toBe(true);
    expect(fresh.settled).toBe(false);
    // A third caller must join the NEW in-flight refresh, not start another.
    const joiner = settleTracker(mod.refreshAccessToken());
    await settleMicrotasks();
    expect(fetches).toEqual(["refresh-old", "refresh-new"]);
    releaseNew(streamed(JSON.stringify({ access_token: "access-new-2" })));
    await vi.advanceTimersByTimeAsync(1);
    expect(fresh.value).toBe("access-new-2");
    expect(joiner.value).toBe("access-new-2");
  });

  it("stalled refresh then clear only: the next refresh is null without another fetch", async () => {
    vi.useFakeTimers();
    const stale = settleTracker(mod.refreshAccessToken());
    await settleMicrotasks();
    await mod.clearTokens();
    await expect(mod.refreshAccessToken()).resolves.toBeNull();
    expect(fetches).toEqual(["refresh-1"]);
    await expect(mod.hasActiveSession()).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(stale.value).toBeNull();
    await expect(mod.hasActiveSession()).resolves.toBe(false);
  });

  it("a non-2xx refresh reply is not parsed but its body is cancelled", async () => {
    let cancelRequested = false;
    fetchImpl = async (_url, _init) =>
      stalledResponse(401, () => {
        cancelRequested = true;
        return new Promise(() => {});
      });
    await expect(mod.refreshAccessToken()).resolves.toBeNull();
    expect(cancelRequested).toBe(true);
    expect(store.get(REFRESH_KEY)).toBe("refresh-1");
    const events = warn.mock.calls.map(([line]) => JSON.parse(line).event);
    expect(events).not.toContain("refresh_body_parse_error");
    expect(events).not.toContain("auth_body_cancel_failed");
  });

  it("an oversized refresh body is a parse failure: nothing committed, token kept", async () => {
    fetchImpl = async (_url, _init) =>
      streamed(
        JSON.stringify({ access_token: "x".repeat(MAX_AUTH_BODY_BYTES + 1) }),
      );
    await expect(mod.refreshAccessToken()).resolves.toBeNull();
    expect(store.get(REFRESH_KEY)).toBe("refresh-1");
    const events = warn.mock.calls.map(([line]) => JSON.parse(line).event);
    expect(events).toContain("refresh_body_parse_error");
  });

  it("same-epoch concurrent refreshes still coalesce onto one fetch", async () => {
    /** @type {(value: Response) => void} */
    let release = () => {};
    fetchImpl = (_url, _init) =>
      new Promise((r) => {
        release = r;
      });
    const all = Promise.all([
      mod.refreshAccessToken(),
      mod.refreshAccessToken(),
      mod.refreshAccessToken(),
    ]);
    await settleMicrotasks();
    release(streamed(JSON.stringify({ access_token: "access-k" })));
    await expect(all).resolves.toEqual(["access-k", "access-k", "access-k"]);
    expect(fetches).toEqual(["refresh-1"]);
  });
});
