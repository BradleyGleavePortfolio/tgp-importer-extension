import { describe, it, expect, vi, afterEach } from "vitest";
import {
  makeBgMock,
  installChrome,
  acceptedIngest,
} from "./helpers/background-mock.js";

// Regression for S4-R4-A-01 (MATERIAL) and S4-R4-A-02 / S4-R4B-01 through the
// REAL router, worker orchestration, replay engine and session module (only
// chrome.* and HTTP are mocked).
//
// A-01: an accepted Start must be bound to the session that was current at
// admission. On R4 the worker read the session generation only AFTER its cold
// preflight refresh resolved, so a pairing acknowledged while that refresh was
// on the wire (or queued behind its rotation persist) became the run's owner:
// every ingest/progress/complete went out under the replacement's bearer, and
// in another interleaving the run broadcast "login required" although the
// replacement was fine.
//
// A-02: a refresh requested on behalf of the obsolete run, queued behind the
// replacement's establish on the state lock, read and presented the
// replacement's refresh token (rotating it) — the obsolete run must present
// nothing of the replacement's.
//
// Both entrypoints (start_import and legacy start_ingest), the ingest sender
// and the settlement caller are covered, plus the bounded neighbours: cold
// preflight success / rejection / timeout, pending-establish FAILURE (the
// current session stays and its refresh legitimately proceeds), clear then
// re-establish, and rotation persist failure (unchanged fail-closed).

const REFRESH_KEY = "tgp_refresh_token";
const REFRESH_URL = "https://api.tgp.coach/api/auth/extension/refresh";
const INGEST_URL = "https://api.tgp.coach/api/scout/ingest";
const COMPLETE_URL = "https://api.tgp.coach/api/scout/ingest/complete";
const PROGRESS_URL = "https://api.tgp.coach/api/scout/progress";
const CLIENTS_PREFIX = "https://app.truecoach.co/proxy/api/clients?";
const NOTES_URL = "https://app.truecoach.co/proxy/api/clients/c1/notes";
const TAB_URL = "https://app.truecoach.co/clients";
const TAB_ID = 42;
const SOURCE_TOKEN = "SYNTHETIC_SOURCE";
const REPLACED_DETAIL =
  "import stopped — your TGP session changed during the import. Start the import again.";
const EXPIRED_DETAIL = "session expired — please sign in again";
const LOGIN_REQUIRED = "login required to import";

const OLD = { accessToken: "OLD_SYNTHETIC_ACCESS", refreshToken: "OLD_RT" };
const NEW = { accessToken: "NEW_SYNTHETIC_ACCESS", refreshToken: "NEW_RT" };
const OLD_MINTED = "OLD_MINTED_ACCESS";
const OLD_ROTATED = "OLD_ROTATED_RT";

function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => undefined;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const realTick = () => new Promise((r) => setTimeout(r, 0));
async function until(predicate, tick = realTick) {
  for (let i = 0; i < 4000; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("observation did not arrive");
}
async function flush(rounds = 50) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function snapshots(mock) {
  return mock.sent.filter((m) => m && m.kind === "status_snapshot");
}
function authRequired(mock) {
  return mock.sent.filter((m) => m && m.kind === "auth_required");
}
function lastSnapshot(mock) {
  return snapshots(mock).at(-1);
}
function lastStatus(mock) {
  const last = lastSnapshot(mock);
  return last && last.intent ? last.intent.status : null;
}
// A run is over when it reached a terminal intent status, broadcast
// auth_required, or stopped in preflight (no intent, honest detail).
function terminal(mock) {
  const status = lastStatus(mock);
  const last = lastSnapshot(mock);
  return (
    status === "ingest_succeeded" ||
    status === "ingest_failed" ||
    status === "ingest_partial" ||
    status === "ingest_empty" ||
    authRequired(mock).length > 0 ||
    (last !== undefined &&
      last.intent === null &&
      typeof last.lastError === "string" &&
      last.lastError.length > 0)
  );
}

function minted(access, refresh) {
  return Response.json({ access_token: access, refresh_token: refresh });
}

// Route table. `refresh(n, presentedRefreshToken)` and `ingest(n, init)` are
// per-case hooks; `complete(n, init)` defaults to 200. Every call records the
// bearer it presented and, for refreshes, the refresh token in the body.
/**
 * @param {{
 *   refresh: (n: number, presented: string | null) => any,
 *   ingest: (n: number, init: any) => any,
 *   complete?: (n: number, init: any) => any,
 * }} hooks
 */
function makeRoutes({ refresh, ingest, complete }) {
  /** @type {Array<{ url: string, authorization: string | null, refreshToken: string | null }>} */
  const calls = [];
  const count = (target) => calls.filter((c) => c.url === target).length;
  const fetchImpl = vi.fn(async (url, init) => {
    const headers = init && init.headers ? init.headers : {};
    const bearer = headers.Authorization;
    const refreshToken =
      url === REFRESH_URL ? JSON.parse(init.body).refresh_token : null;
    calls.push({
      url,
      authorization: typeof bearer === "string" ? bearer : null,
      refreshToken,
    });
    if (url === REFRESH_URL) {
      return refresh(count(REFRESH_URL), refreshToken);
    }
    if (url === INGEST_URL) {
      return ingest(count(INGEST_URL), init);
    }
    if (url === COMPLETE_URL) {
      return complete
        ? complete(count(COMPLETE_URL), init)
        : new Response(null, { status: 200 });
    }
    if (url.startsWith(CLIENTS_PREFIX) && url.includes("page=1")) {
      return Response.json({ clients: [{ id: "c1" }] });
    }
    if (url.startsWith(CLIENTS_PREFIX)) {
      return Response.json({ clients: [] });
    }
    if (url === NOTES_URL) {
      return Response.json({ notes: [{ id: "n1" }] });
    }
    if (url === PROGRESS_URL) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unrouted fetch ${url}`);
  });
  return { fetchImpl, calls };
}

// Cold worker: a refresh token survives in chrome.storage.session, no access
// token is in memory (service-worker wake), so any Start must preflight-refresh.
async function loadCold(routes) {
  vi.resetModules();
  const mock = makeBgMock({
    session: [[REFRESH_KEY, OLD.refreshToken]],
    tab: { url: TAB_URL, token: SOURCE_TOKEN },
  });
  installChrome(mock);
  vi.stubGlobal("fetch", routes.fetchImpl);
  await import("../background.js");
  // Same module instance background.js imported (module cache is shared).
  const session = await import("../shared/session.js");
  return { mock, session };
}

// Warm worker: the OLD session was acknowledged and is in memory.
async function loadWarm(routes) {
  vi.resetModules();
  const mock = makeBgMock({ tab: { url: TAB_URL, token: SOURCE_TOKEN } });
  installChrome(mock);
  vi.stubGlobal("fetch", routes.fetchImpl);
  await import("../background.js");
  const session = await import("../shared/session.js");
  const ack = await mock.dispatch({ kind: "session_established", ...OLD });
  expect(ack).toEqual({ ok: true });
  mock.sent.length = 0;
  return { mock, session };
}

// Hold chrome.storage.session.set open while it is about to persist `value`
// under the refresh key: models the establish (or rotation) that owns the
// state lock but has not committed. Returns { entered, release }.
function holdPersistOf(mock, value) {
  const area = mock.chrome.storage.session;
  const originalSet = area.set;
  const barrier = deferred();
  let entered = false;
  area.set = async (obj) => {
    if (obj[REFRESH_KEY] === value) {
      entered = true;
      await barrier.promise;
    }
    return originalSet(obj);
  };
  return {
    entered: () => entered,
    release: () => {
      barrier.resolve(undefined);
      area.set = originalSet;
    },
  };
}

// Make the persist of `value` under the refresh key THROW (storage failure).
function failPersistOf(mock, value) {
  const area = mock.chrome.storage.session;
  const originalSet = area.set;
  let failed = 0;
  area.set = async (obj) => {
    if (obj[REFRESH_KEY] === value) {
      failed += 1;
      throw new Error("storage unavailable");
    }
    return originalSet(obj);
  };
  return { failures: () => failed };
}

async function start(mock, kind = "start_import") {
  const ack = await mock.dispatch({
    kind,
    url: TAB_URL,
    tabId: TAB_ID,
    sourceToken: SOURCE_TOKEN,
  });
  expect(ack).toEqual({ ok: true });
}

function replace(mock) {
  return mock.dispatch({ kind: "session_established", ...NEW });
}

// What every replaced-session case must end in: the replacement is intact and
// was never used, presented, rotated or declared missing by the obsolete run;
// the run stopped honestly and released the single-flight guard.
async function expectReplacementIntact(
  mock,
  calls,
  { preflight = false } = {},
) {
  expect(mock.sessionMap.get(REFRESH_KEY)).toBe(NEW.refreshToken);
  const state = await mock.dispatch({ kind: "request_session_state" });
  expect(state).toEqual({ ok: true, hasSession: true });
  expect(authRequired(mock)).toHaveLength(0);
  const last = lastSnapshot(mock);
  expect(last.lastError).toBe(REPLACED_DETAIL);
  if (preflight) {
    expect(last.intent).toBeNull();
  } else {
    expect(lastStatus(mock)).toBe("ingest_failed");
  }
  const details = snapshots(mock).map((s) => s.lastError);
  expect(details).not.toContain(EXPIRED_DETAIL);
  expect(details).not.toContain(LOGIN_REQUIRED);
  // Nothing under the replacement's bearer, no settlement, and the
  // replacement's refresh token was never presented (so never rotated).
  expect(
    calls.filter((c) => c.authorization === `Bearer ${NEW.accessToken}`),
  ).toEqual([]);
  expect(calls.filter((c) => c.url === COMPLETE_URL)).toEqual([]);
  const presented = calls
    .filter((c) => c.url === REFRESH_URL)
    .map((c) => c.refreshToken);
  expect(presented).not.toContain(NEW.refreshToken);
  // Guard released: an unsupported URL is admitted (no second crawl starts).
  const again = await mock.dispatch({
    kind: "start_import",
    url: "https://example.invalid/",
    tabId: TAB_ID,
  });
  expect(again).toEqual({ ok: true });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
describe("accepted Start binds its owner before the cold preflight refresh (S4-R4-A-01)", () => {
  for (const kind of ["start_import", "start_ingest"]) {
    it(`${kind}: replacement queued behind the preflight refresh's rotation persist (C3 barrier) → run stops, replacement never used`, async () => {
      const routes = makeRoutes({
        refresh: () => minted(OLD_MINTED, OLD_ROTATED),
        ingest: (_n, init) => acceptedIngest(init),
      });
      const { mock } = await loadCold(routes);
      const rotation = holdPersistOf(mock, OLD_ROTATED);
      await start(mock, kind);
      await until(rotation.entered);
      // The replacement is acknowledged while the rotation commit holds the
      // lock: it is serialized right behind it — before the Start's preflight
      // returns to the worker. On R4 the worker then read the generation and
      // adopted the replacement as the run's owner.
      const replacing = replace(mock);
      await flush();
      rotation.release();
      expect(await replacing).toEqual({ ok: true });
      await until(() => terminal(mock));
      await flush();
      expect(
        routes.calls
          .filter((c) => c.url === REFRESH_URL)
          .map((c) => c.refreshToken),
      ).toEqual([OLD.refreshToken]);
      // Not a single request under any bearer after the replacement.
      expect(routes.calls.filter((c) => c.url !== REFRESH_URL)).toEqual([]);
      await expectReplacementIntact(mock, routes.calls, { preflight: true });
    });

    it(`${kind}: replacement acknowledged while the preflight refresh is on the wire (C1) → no false "login required", run stops`, async () => {
      const held = deferred();
      const routes = makeRoutes({
        refresh: () => held.promise,
        ingest: (_n, init) => acceptedIngest(init),
      });
      const { mock } = await loadCold(routes);
      await start(mock, kind);
      await until(() => routes.calls.some((c) => c.url === REFRESH_URL));
      expect(await replace(mock)).toEqual({ ok: true });
      held.resolve(minted(OLD_MINTED, OLD_ROTATED));
      await until(() => terminal(mock));
      await flush();
      expect(routes.calls.filter((c) => c.url !== REFRESH_URL)).toEqual([]);
      // The fenced OLD rotation did not overwrite the replacement.
      await expectReplacementIntact(mock, routes.calls, { preflight: true });
    });
  }

  it("start_import: preflight refresh REJECTED (401) after the replacement landed → replaced, not 'login required'", async () => {
    const held = deferred();
    const routes = makeRoutes({
      refresh: () => held.promise,
      ingest: (_n, init) => acceptedIngest(init),
    });
    const { mock } = await loadCold(routes);
    await start(mock);
    await until(() => routes.calls.some((c) => c.url === REFRESH_URL));
    expect(await replace(mock)).toEqual({ ok: true });
    held.resolve(new Response(null, { status: 401 }));
    await until(() => terminal(mock));
    await flush();
    await expectReplacementIntact(mock, routes.calls, { preflight: true });
  });

  it("start_import: preflight refresh TIMEOUT after the replacement landed → replaced, not 'login required'", async () => {
    vi.useFakeTimers();
    const tick = () => vi.advanceTimersByTimeAsync(1);
    const routes = makeRoutes({
      refresh: () => new Promise(() => undefined), // never settles
      ingest: (_n, init) => acceptedIngest(init),
    });
    const { mock } = await loadCold(routes);
    await start(mock);
    await until(() => routes.calls.some((c) => c.url === REFRESH_URL), tick);
    expect(await replace(mock)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(15000); // refresh deadline elapses
    await until(() => terminal(mock), tick);
    await expectReplacementIntact(mock, routes.calls, { preflight: true });
  }, 15000);

  it("start_import: session CLEARED then re-established while the preflight refresh is on the wire → run stops, new session untouched", async () => {
    const held = deferred();
    const routes = makeRoutes({
      refresh: () => held.promise,
      ingest: (_n, init) => acceptedIngest(init),
    });
    const { mock, session } = await loadCold(routes);
    await start(mock);
    await until(() => routes.calls.some((c) => c.url === REFRESH_URL));
    await session.clearTokens();
    expect(await replace(mock)).toEqual({ ok: true });
    held.resolve(minted(OLD_MINTED, OLD_ROTATED));
    await until(() => terminal(mock));
    await flush();
    await expectReplacementIntact(mock, routes.calls, { preflight: true });
  });

  // Unchanged-session controls: the same schedules with no transition mint and
  // import under the OWNING session's freshly minted bearer, on both entrypoints.
  it("control — start_import cold preflight with no transition: mints once and imports under the minted bearer", async () => {
    const routes = makeRoutes({
      refresh: () => minted(OLD_MINTED, OLD_ROTATED),
      ingest: (_n, init) => acceptedIngest(init),
    });
    const { mock } = await loadCold(routes);
    await start(mock);
    await until(() => terminal(mock));
    expect(lastStatus(mock)).toBe("ingest_succeeded");
    expect(authRequired(mock)).toHaveLength(0);
    const tgp = routes.calls.filter(
      (c) =>
        c.url !== REFRESH_URL && c.url.startsWith("https://api.tgp.coach/"),
    );
    expect(tgp.length).toBeGreaterThan(0);
    expect(new Set(tgp.map((c) => c.authorization))).toEqual(
      new Set([`Bearer ${OLD_MINTED}`]),
    );
    expect(mock.sessionMap.get(REFRESH_KEY)).toBe(OLD_ROTATED);
  });

  it("control — cold preflight refresh REJECTED with no transition still reports 'login required' exactly once (both entrypoints)", async () => {
    for (const kind of ["start_import", "start_ingest"]) {
      const routes = makeRoutes({
        refresh: () => new Response(null, { status: 401 }),
        ingest: (_n, init) => acceptedIngest(init),
      });
      const { mock } = await loadCold(routes);
      await start(mock, kind);
      await until(() => terminal(mock));
      expect(authRequired(mock)).toHaveLength(1);
      expect(lastSnapshot(mock).lastError).toBe(LOGIN_REQUIRED);
      expect(routes.calls.map((c) => c.url)).toEqual([REFRESH_URL]);
    }
  });

  it("control — pending establish FAILURE during the preflight refresh: the OLD session stays current and the run proceeds under it", async () => {
    const held = deferred();
    const routes = makeRoutes({
      refresh: () => held.promise,
      ingest: (_n, init) => acceptedIngest(init),
    });
    const { mock } = await loadCold(routes);
    const failing = failPersistOf(mock, NEW.refreshToken);
    await start(mock);
    await until(() => routes.calls.some((c) => c.url === REFRESH_URL));
    expect(await replace(mock)).toEqual({
      ok: false,
      error: "session_persist_failed",
    });
    expect(failing.failures()).toBe(1);
    held.resolve(minted(OLD_MINTED, OLD_ROTATED));
    await until(() => terminal(mock));
    expect(lastStatus(mock)).toBe("ingest_succeeded");
    expect(authRequired(mock)).toHaveLength(0);
    expect(mock.sessionMap.get(REFRESH_KEY)).toBe(OLD_ROTATED);
    expect(
      routes.calls.filter(
        (c) => c.authorization === `Bearer ${NEW.accessToken}`,
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("a refresh on behalf of an obsolete run never presents the replacement's token (S4-R4-A-02)", () => {
  it("ingest 401 → refresh queued behind the replacement's establish (persist held, C2): nothing presented, replacement not rotated, run stops", async () => {
    const firstIngest = deferred();
    const routes = makeRoutes({
      refresh: (_n, presented) =>
        minted(`MINTED_FOR_${presented}`, `ROTATED_FROM_${presented}`),
      ingest: (n, init) =>
        n === 1 ? firstIngest.promise : acceptedIngest(init),
    });
    const { mock } = await loadWarm(routes);
    const establish = holdPersistOf(mock, NEW.refreshToken);
    await start(mock);
    await until(() => routes.calls.some((c) => c.url === INGEST_URL));
    const replacing = replace(mock);
    await until(establish.entered);
    // The OLD run's ingest fails 401 while the replacement owns the lock: its
    // refresh (bound to the OLD session) is admitted behind the establish.
    firstIngest.resolve(new Response(null, { status: 401 }));
    await flush();
    await realTick();
    expect(routes.calls.filter((c) => c.url === REFRESH_URL)).toEqual([]);
    establish.release();
    expect(await replacing).toEqual({ ok: true });
    await until(() => terminal(mock));
    await flush();
    // Stood down without reading the replacement's token: no refresh at all.
    expect(routes.calls.filter((c) => c.url === REFRESH_URL)).toEqual([]);
    expect(routes.calls.filter((c) => c.url === INGEST_URL)).toHaveLength(1);
    await expectReplacementIntact(mock, routes.calls);
  });

  it("ingest 401 fired from inside the replacement's persist (P-C pending admission): nothing presented, replacement not rotated, run stops", async () => {
    /** @type {ReturnType<typeof holdPersistOf> | null} */
    let establish = null;
    /** @type {Promise<any> | null} */
    let replacing = null;
    const routes = makeRoutes({
      refresh: (_n, presented) =>
        minted(`MINTED_FOR_${presented}`, `ROTATED_FROM_${presented}`),
      ingest: async (n, init) => {
        if (n === 1) {
          // Replacement acknowledged and parked inside storage.set before the
          // 401 reaches the sender.
          const hold = holdPersistOf(mock, NEW.refreshToken);
          establish = hold;
          replacing = replace(mock);
          await until(() => hold.entered());
          return new Response(null, { status: 401 });
        }
        return acceptedIngest(init);
      },
    });
    const { mock } = await loadWarm(routes);
    await start(mock);
    await until(() => establish !== null && establish.entered());
    await flush();
    await realTick();
    expect(routes.calls.filter((c) => c.url === REFRESH_URL)).toEqual([]);
    if (establish === null) throw new Error("replacement never parked");
    establish.release();
    expect(await replacing).toEqual({ ok: true });
    await until(() => terminal(mock));
    await flush();
    expect(routes.calls.filter((c) => c.url === REFRESH_URL)).toEqual([]);
    await expectReplacementIntact(mock, routes.calls);
  });

  it("settlement (complete) 401 → refresh queued behind the replacement's establish: nothing presented, run left unsettled, replacement intact", async () => {
    const firstComplete = deferred();
    const routes = makeRoutes({
      refresh: (_n, presented) =>
        minted(`MINTED_FOR_${presented}`, `ROTATED_FROM_${presented}`),
      ingest: (_n, init) => acceptedIngest(init),
      complete: (n) =>
        n === 1 ? firstComplete.promise : new Response(null, { status: 200 }),
    });
    const { mock } = await loadWarm(routes);
    const establish = holdPersistOf(mock, NEW.refreshToken);
    await start(mock);
    await until(() => routes.calls.some((c) => c.url === COMPLETE_URL));
    const replacing = replace(mock);
    await until(establish.entered);
    firstComplete.resolve(new Response(null, { status: 401 }));
    await flush();
    await realTick();
    expect(routes.calls.filter((c) => c.url === REFRESH_URL)).toEqual([]);
    establish.release();
    expect(await replacing).toEqual({ ok: true });
    await until(() => terminal(mock));
    await flush();
    expect(routes.calls.filter((c) => c.url === REFRESH_URL)).toEqual([]);
    const completes = routes.calls.filter((c) => c.url === COMPLETE_URL);
    expect(completes).toHaveLength(1);
    expect(completes[0].authorization).toBe(`Bearer ${OLD.accessToken}`);
    // The replacement is intact and unused; the run reported an honest stop.
    expect(mock.sessionMap.get(REFRESH_KEY)).toBe(NEW.refreshToken);
    expect(authRequired(mock)).toHaveLength(0);
    expect(lastStatus(mock)).toBe("ingest_failed");
    expect(lastSnapshot(mock).lastError).toBe(REPLACED_DETAIL);
    expect(
      routes.calls.filter(
        (c) => c.authorization === `Bearer ${NEW.accessToken}`,
      ),
    ).toEqual([]);
  });

  it("ingest 401 → refresh queued behind a CLEAR then re-establish: nothing presented, new session intact, run stops", async () => {
    const firstIngest = deferred();
    const routes = makeRoutes({
      refresh: (_n, presented) =>
        minted(`MINTED_FOR_${presented}`, `ROTATED_FROM_${presented}`),
      ingest: (n, init) =>
        n === 1 ? firstIngest.promise : acceptedIngest(init),
    });
    const { mock, session } = await loadWarm(routes);
    const area = mock.chrome.storage.session;
    const originalRemove = area.remove;
    const removal = deferred();
    let removing = false;
    area.remove = async (key) => {
      removing = true;
      await removal.promise;
      return originalRemove(key);
    };
    await start(mock);
    await until(() => routes.calls.some((c) => c.url === INGEST_URL));
    const clearing = session.clearTokens();
    await until(() => removing);
    const replacing = replace(mock);
    firstIngest.resolve(new Response(null, { status: 401 }));
    await flush();
    await realTick();
    expect(routes.calls.filter((c) => c.url === REFRESH_URL)).toEqual([]);
    removal.resolve(undefined);
    area.remove = originalRemove;
    await clearing;
    expect(await replacing).toEqual({ ok: true });
    await until(() => terminal(mock));
    await flush();
    expect(routes.calls.filter((c) => c.url === REFRESH_URL)).toEqual([]);
    await expectReplacementIntact(mock, routes.calls);
  });

  // Controls: the same 401 → refresh path with NO transition keeps working
  // (presents OLD once, retries under the minted bearer, succeeds), and a
  // rotation persist failure for the CURRENT session still fails closed.
  it("control — ingest 401 → refresh with no transition: OLD presented once, retry under the minted bearer, success", async () => {
    const routes = makeRoutes({
      refresh: () => minted(OLD_MINTED, OLD_ROTATED),
      ingest: (n, init) =>
        n === 1 ? new Response(null, { status: 401 }) : acceptedIngest(init),
    });
    const { mock } = await loadWarm(routes);
    await start(mock);
    await until(() => terminal(mock));
    expect(lastStatus(mock)).toBe("ingest_succeeded");
    expect(authRequired(mock)).toHaveLength(0);
    expect(
      routes.calls
        .filter((c) => c.url === REFRESH_URL)
        .map((c) => c.refreshToken),
    ).toEqual([OLD.refreshToken]);
    // First batch under the original bearer (401), everything after it — the
    // retry and the later batches — under the minted one.
    const ingests = routes.calls.filter((c) => c.url === INGEST_URL);
    expect(ingests.length).toBeGreaterThanOrEqual(2);
    expect(ingests[0].authorization).toBe(`Bearer ${OLD.accessToken}`);
    expect(new Set(ingests.slice(1).map((c) => c.authorization))).toEqual(
      new Set([`Bearer ${OLD_MINTED}`]),
    );
    expect(mock.sessionMap.get(REFRESH_KEY)).toBe(OLD_ROTATED);
  });

  it("control — rotation persist FAILURE for the current session: no new token published, auth_required exactly once, no replacement involved", async () => {
    const routes = makeRoutes({
      refresh: () => minted(OLD_MINTED, OLD_ROTATED),
      ingest: (n, init) =>
        n === 1 ? new Response(null, { status: 401 }) : acceptedIngest(init),
    });
    const { mock } = await loadWarm(routes);
    const failing = failPersistOf(mock, OLD_ROTATED);
    await start(mock);
    await until(() => terminal(mock));
    expect(failing.failures()).toBe(1);
    expect(authRequired(mock)).toHaveLength(1);
    expect(lastSnapshot(mock).lastError).toBe(EXPIRED_DETAIL);
    // The minted bearer was never published or used.
    expect(
      routes.calls.filter((c) => c.authorization === `Bearer ${OLD_MINTED}`),
    ).toEqual([]);
    expect(mock.sessionMap.has(REFRESH_KEY)).toBe(false);
  });
});
