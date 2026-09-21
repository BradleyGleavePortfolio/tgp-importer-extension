import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression for S4-R3-A-01 / S4-R3B-01: coalescer admission must be coherent
// with the serialized establish/clear transitions. A refresh admitted while a
// transition holds the state lock has NOT snapshotted yet; it will read the
// NEW session, so it must stay joinable — detaching it let a second caller in
// the same RTT present the new refresh token in parallel (a duplicate fetch
// the backend's reuse detection would punish with a forced re-pair). A run
// that already snapshotted the OLD session is stale and must be detached.
//
// No network, no timers: storage transitions are held open with explicit
// barriers and every fetch is released by the test.

const REFRESH_KEY = "tgp_refresh_token";

function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => undefined;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(rounds = 50) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function minted(access, refresh) {
  return Response.json({ access_token: access, refresh_token: refresh });
}

// Storage mock whose set/remove can be held open on a barrier, modelling the
// window in which establish/clear owns the state lock but has not committed.
function makeStorage(seed) {
  const store = new Map(seed ?? []);
  /** @type {{ promise: Promise<any> } | null} */
  let holdSet = null;
  /** @type {{ promise: Promise<any> } | null} */
  let holdRemove = null;
  const chrome = {
    storage: {
      session: {
        get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (obj) => {
          if (holdSet !== null) await holdSet.promise;
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        remove: async (key) => {
          if (holdRemove !== null) await holdRemove.promise;
          store.delete(key);
        },
      },
    },
  };
  return {
    store,
    chrome,
    holdNextSet: (barrier) => {
      holdSet = barrier;
    },
    releaseSet: () => {
      holdSet = null;
    },
    holdNextRemove: (barrier) => {
      holdRemove = barrier;
    },
    releaseRemove: () => {
      holdRemove = null;
    },
  };
}

// fetch mock: records the refresh token each call presents and lets the test
// release each response individually.
function makeFetch() {
  /** @type {string[]} */
  const presented = [];
  /** @type {Array<(value: any) => void>} */
  const releases = [];
  const fetchImpl = vi.fn(async (_url, init) => {
    presented.push(JSON.parse(init.body).refresh_token);
    return new Promise((r) => {
      releases.push(r);
    });
  });
  return { fetchImpl, presented, releases };
}

async function load(seed = [[REFRESH_KEY, "OLD_REFRESH"]]) {
  vi.resetModules();
  const storage = makeStorage(seed);
  const net = makeFetch();
  vi.stubGlobal("chrome", storage.chrome);
  vi.stubGlobal("fetch", net.fetchImpl);
  const session = await import("../shared/session.js");
  return { session, storage, net };
}

async function establish(session, access, refresh) {
  expect(await session.establishSession(access, refresh)).toEqual({ ok: true });
}

describe("refresh admission vs establish/clear (S4-R3-A-01)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a refresh admitted while establish is persisting queues behind it, reads the NEW session, and the next caller joins it: ONE fetch, both minted", async () => {
    const { session, storage, net } = await load();
    const persist = deferred();
    storage.holdNextSet(persist);
    // Trusted session_established handler begins persisting a new session.
    const established = session.establishSession("NEW_ACCESS", "NEW_REFRESH");
    await flush();
    // An outstanding ingest 401 requests a refresh during storage.set: it is
    // admitted now but its snapshot queues behind the establish.
    const queued = session.refreshAccessToken();
    await flush();
    expect(net.presented).toEqual([]); // nothing presented before the snapshot
    persist.resolve(undefined);
    storage.releaseSet();
    expect(await established).toEqual({ ok: true });
    await flush();
    // The queued run snapshotted the NEW session and presented its token once.
    expect(net.presented).toEqual(["NEW_REFRESH"]);
    // Another caller for the now-established session joins that same run
    // instead of presenting NEW_REFRESH a second time.
    const following = session.refreshAccessToken();
    await flush();
    expect(net.presented).toEqual(["NEW_REFRESH"]);
    expect(net.fetchImpl).toHaveBeenCalledTimes(1);
    net.releases[0](minted("MINTED_ACCESS", "ROTATED_REFRESH"));
    expect(await Promise.all([queued, following])).toEqual([
      "MINTED_ACCESS",
      "MINTED_ACCESS",
    ]);
    expect(storage.store.get(REFRESH_KEY)).toBe("ROTATED_REFRESH");
    expect(await session.getAccessToken()).toBe("MINTED_ACCESS");
  });

  it("a run that already snapshotted the OLD session is detached by a replacement; the new session refreshes on its own and the stale result is fenced", async () => {
    const { session, storage, net } = await load();
    const stale = session.refreshAccessToken();
    await flush();
    expect(net.presented).toEqual(["OLD_REFRESH"]); // snapshotted + on the wire
    await establish(session, "NEW_ACCESS", "NEW_REFRESH");
    // A caller for the NEW session must not be handed the stale run.
    const fresh = session.refreshAccessToken();
    await flush();
    expect(net.presented).toEqual(["OLD_REFRESH", "NEW_REFRESH"]);
    // Stale success arrives: epoch-fenced to null, never resurrects OLD.
    net.releases[0](minted("STALE_ACCESS", "STALE_ROTATED"));
    expect(await stale).toBeNull();
    expect(storage.store.get(REFRESH_KEY)).toBe("NEW_REFRESH");
    // The stale run's finally must not have vacated the NEW run's slot: a
    // third caller still joins it (no third fetch).
    const joiner = session.refreshAccessToken();
    await flush();
    expect(net.fetchImpl).toHaveBeenCalledTimes(2);
    net.releases[1](minted("MINTED_ACCESS", "ROTATED_REFRESH"));
    expect(await Promise.all([fresh, joiner])).toEqual([
      "MINTED_ACCESS",
      "MINTED_ACCESS",
    ]);
    expect(storage.store.get(REFRESH_KEY)).toBe("ROTATED_REFRESH");
  });

  it("a refresh admitted while clearTokens is in progress reads no session, presents nothing, and does not poison a later establish", async () => {
    const { session, storage, net } = await load();
    const removal = deferred();
    storage.holdNextRemove(removal);
    const cleared = session.clearTokens();
    await flush();
    const duringClear = session.refreshAccessToken();
    await flush();
    removal.resolve(undefined);
    storage.releaseRemove();
    await cleared;
    // Queued behind the clear: the snapshot sees no refresh token.
    expect(await duringClear).toBeNull();
    expect(net.fetchImpl).not.toHaveBeenCalled();
    // A later pairing starts clean: its first refresh presents NEW_REFRESH once
    // and is shared.
    await establish(session, "NEW_ACCESS", "NEW_REFRESH");
    const a = session.refreshAccessToken();
    const b = session.refreshAccessToken();
    await flush();
    expect(net.presented).toEqual(["NEW_REFRESH"]);
    net.releases[0](minted("MINTED_ACCESS", "ROTATED_REFRESH"));
    expect(await Promise.all([a, b])).toEqual([
      "MINTED_ACCESS",
      "MINTED_ACCESS",
    ]);
  });

  it("clearTokensIfSession clears only the session it was bound to and reports which", async () => {
    const { session, storage } = await load();
    const bound = session.getSessionGeneration();
    // A replacement lands: the bound generation is obsolete.
    await establish(session, "NEW_ACCESS", "NEW_REFRESH");
    expect(await session.clearTokensIfSession(bound)).toBe(false);
    expect(storage.store.get(REFRESH_KEY)).toBe("NEW_REFRESH");
    expect(await session.hasActiveSession()).toBe(true);
    // Bound to the current session: clears, exactly as clearTokens would.
    const current = session.getSessionGeneration();
    expect(current).not.toBe(bound);
    expect(await session.clearTokensIfSession(current)).toBe(true);
    expect(storage.store.has(REFRESH_KEY)).toBe(false);
    expect(await session.hasActiveSession()).toBe(false);
  });

  // The generation is an identity, not a version: a rotation must not move it
  // (a run's own refresh would otherwise disown the run).
  it("a refresh rotation keeps the session generation (identity), while establish and clear each move it", async () => {
    const { session, net } = await load();
    const before = session.getSessionGeneration();
    const run = session.refreshAccessToken();
    await flush();
    net.releases[0](minted("MINTED_ACCESS", "ROTATED_REFRESH"));
    expect(await run).toBe("MINTED_ACCESS");
    expect(session.getSessionGeneration()).toBe(before);
    await establish(session, "NEW_ACCESS", "NEW_REFRESH");
    const afterEstablish = session.getSessionGeneration();
    expect(afterEstablish).not.toBe(before);
    await session.clearTokens();
    expect(session.getSessionGeneration()).not.toBe(afterEstablish);
  });
});
