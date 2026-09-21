import { describe, it, expect, vi, afterEach } from "vitest";
import {
  makeBgMock,
  installChrome,
  acceptedIngest,
} from "./helpers/background-mock.js";

// Regression for S4-R3-A-02 through the REAL router, worker orchestration,
// replay engine and session module (only chrome.* and HTTP are mocked).
//
// A run that started under one TGP session must treat a session that was
// REPLACED (a new pairing acknowledged via the trusted session_established
// route) or cleared meanwhile as making ITS work obsolete:
//   - it must not clear the replacement's tokens or broadcast "session
//     expired" for a session that is fine (the R3 defect),
//   - it must not resume — send, settle, or report — under the replacement's
//     credentials.
// The unchanged-current-session auth loss keeps its existing behaviour: clear
// the tokens and broadcast auth_required exactly once (negative control).

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

const OLD = { accessToken: "OLD_SYNTHETIC_ACCESS", refreshToken: "OLD_RT" };
const NEW = { accessToken: "NEW_SYNTHETIC_ACCESS", refreshToken: "NEW_RT" };

function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => undefined;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Poll on macrotask ticks (each drains the microtask queue) until `predicate`
// holds. `tick` is swapped for a fake-timer advance in the timeout case.
const realTick = () => new Promise((r) => setTimeout(r, 0));
async function until(predicate, tick = realTick) {
  for (let i = 0; i < 4000; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("observation did not arrive");
}

function snapshots(mock) {
  return mock.sent.filter((m) => m && m.kind === "status_snapshot");
}
function authRequired(mock) {
  return mock.sent.filter((m) => m && m.kind === "auth_required");
}
function lastStatus(mock) {
  const last = snapshots(mock).at(-1);
  return last && last.intent ? last.intent.status : null;
}
function terminal(mock) {
  const status = lastStatus(mock);
  return (
    status === "ingest_succeeded" ||
    status === "ingest_failed" ||
    status === "ingest_partial" ||
    authRequired(mock).length > 0
  );
}

// Route table shared by every case. `refresh` and `ingest` are hooks the case
// controls; every call is recorded with the bearer it presented.
function makeRoutes({ refresh, ingest }) {
  /** @type {Array<{ url: string, authorization: string | null, refreshToken: string | null }>} */
  const calls = [];
  const count = (target) => calls.filter((c) => c.url === target).length;
  const fetchImpl = vi.fn(async (url, init) => {
    const headers = init && init.headers ? init.headers : {};
    const bearer = headers.Authorization;
    calls.push({
      url,
      authorization: typeof bearer === "string" ? bearer : null,
      refreshToken:
        url === REFRESH_URL ? JSON.parse(init.body).refresh_token : null,
    });
    if (url === REFRESH_URL) {
      return refresh(count(REFRESH_URL));
    }
    if (url === INGEST_URL) {
      return ingest(count(INGEST_URL), init);
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
    if (url === COMPLETE_URL) {
      return new Response(null, { status: 200 });
    }
    throw new Error(`unrouted fetch ${url}`);
  });
  return { fetchImpl, calls };
}

async function load(routes) {
  vi.resetModules();
  const mock = makeBgMock({ tab: { url: TAB_URL, token: SOURCE_TOKEN } });
  installChrome(mock);
  vi.stubGlobal("fetch", routes.fetchImpl);
  await import("../background.js");
  const ack = await mock.dispatch({ kind: "session_established", ...OLD });
  expect(ack).toEqual({ ok: true });
  return mock;
}

async function startImport(mock) {
  const ack = await mock.dispatch({
    kind: "start_import",
    url: TAB_URL,
    tabId: TAB_ID,
  });
  expect(ack).toEqual({ ok: true });
}

async function replaceSession(mock) {
  const ack = await mock.dispatch({ kind: "session_established", ...NEW });
  expect(ack).toEqual({ ok: true });
  expect(mock.sessionMap.get(REFRESH_KEY)).toBe(NEW.refreshToken);
}

// What every replaced-session case must end in.
async function expectReplacementIntact(mock, calls) {
  // The acknowledged replacement is untouched: tokens present, no logout state.
  expect(mock.sessionMap.get(REFRESH_KEY)).toBe(NEW.refreshToken);
  const state = await mock.dispatch({ kind: "request_session_state" });
  expect(state).toEqual({ ok: true, hasSession: true });
  expect(authRequired(mock)).toHaveLength(0);
  // The obsolete run stopped with an honest terminal state, not "expired".
  expect(lastStatus(mock)).toBe("ingest_failed");
  expect(snapshots(mock).at(-1).lastError).toBe(REPLACED_DETAIL);
  expect(snapshots(mock).map((s) => s.lastError)).not.toContain(
    "session expired — please sign in again",
  );
  // Nothing was sent, settled or reported under the replacement's bearer, and
  // the replacement's refresh token was never presented by the old run.
  const newBearer = `Bearer ${NEW.accessToken}`;
  expect(calls.filter((c) => c.authorization === newBearer)).toEqual([]);
  expect(calls.filter((c) => c.url === COMPLETE_URL)).toEqual([]);
  const refreshes = calls.filter((c) => c.url === REFRESH_URL);
  expect(refreshes.map((c) => c.refreshToken)).toEqual(
    refreshes.map(() => OLD.refreshToken),
  );
  // The single-flight guard was released. Probed with an unsupported URL so
  // the router admits the request but no second crawl actually starts.
  const again = await mock.dispatch({
    kind: "start_import",
    url: "https://example.invalid/",
    tabId: TAB_ID,
  });
  expect(again).toEqual({ ok: true });
}

describe("a run whose session is replaced mid-refresh (S4-R3-A-02)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stale refresh SUCCESS after replacement: fenced, no clear, no auth_required, run stops", async () => {
    const held = deferred();
    const routes = makeRoutes({
      refresh: () => held.promise,
      ingest: () => new Response(null, { status: 401 }),
    });
    const mock = await load(routes);
    await startImport(mock);
    await until(() => routes.calls.some((c) => c.url === REFRESH_URL));
    // Re-pair while the old run's refresh is on the wire.
    await replaceSession(mock);
    held.resolve(
      Response.json({
        access_token: "STALE_ACCESS",
        refresh_token: "STALE_ROTATED",
      }),
    );
    await until(() => terminal(mock));
    await expectReplacementIntact(mock, routes.calls);
    expect(mock.sessionMap.get(REFRESH_KEY)).not.toBe("STALE_ROTATED");
  }, 15000);

  it("stale refresh REJECTION (401) after replacement: no clear, no auth_required, run stops", async () => {
    const held = deferred();
    const routes = makeRoutes({
      refresh: () => held.promise,
      ingest: () => new Response(null, { status: 401 }),
    });
    const mock = await load(routes);
    await startImport(mock);
    await until(() => routes.calls.some((c) => c.url === REFRESH_URL));
    await replaceSession(mock);
    held.resolve(new Response(null, { status: 401 }));
    await until(() => terminal(mock));
    await expectReplacementIntact(mock, routes.calls);
  }, 15000);

  it("stale refresh TIMEOUT after replacement: no clear, no auth_required, run stops", async () => {
    vi.useFakeTimers();
    const tick = () => vi.advanceTimersByTimeAsync(1);
    const routes = makeRoutes({
      refresh: () => new Promise(() => undefined), // never settles
      ingest: () => new Response(null, { status: 401 }),
    });
    const mock = await load(routes);
    await startImport(mock);
    await until(() => routes.calls.some((c) => c.url === REFRESH_URL), tick);
    await replaceSession(mock);
    await vi.advanceTimersByTimeAsync(15000); // refresh deadline elapses
    await until(() => terminal(mock), tick);
    await expectReplacementIntact(mock, routes.calls);
  }, 15000);

  it("replacement between a successful refresh and the retry's 401: the retry path does not clear the replacement either", async () => {
    const retry = deferred();
    const routes = makeRoutes({
      refresh: () =>
        Response.json({
          access_token: "OLD_MINTED_ACCESS",
          refresh_token: "OLD_ROTATED",
        }),
      // First batch 401s; the retry (with the freshly minted token) is held.
      ingest: (n) =>
        n === 1 ? new Response(null, { status: 401 }) : retry.promise,
    });
    const mock = await load(routes);
    await startImport(mock);
    const ingests = () => routes.calls.filter((c) => c.url === INGEST_URL);
    await until(() => ingests().length === 2);
    expect(ingests()[1].authorization).toBe("Bearer OLD_MINTED_ACCESS");
    await replaceSession(mock);
    retry.resolve(new Response(null, { status: 401 }));
    await until(() => terminal(mock));
    await expectReplacementIntact(mock, routes.calls);
  }, 15000);

  it("replacement with NO 401 at all: the next batch is not sent under the replacement's bearer", async () => {
    const firstBatch = deferred();
    const routes = makeRoutes({
      refresh: () => {
        throw new Error("no refresh expected");
      },
      ingest: (n, init) =>
        n === 1
          ? firstBatch.promise.then(() => acceptedIngest(init))
          : acceptedIngest(init),
    });
    const mock = await load(routes);
    await startImport(mock);
    const ingests = () => routes.calls.filter((c) => c.url === INGEST_URL);
    await until(() => ingests().length === 1);
    expect(ingests()[0].authorization).toBe(`Bearer ${OLD.accessToken}`);
    await replaceSession(mock);
    // The in-flight batch is acknowledged, but the run now belongs to a
    // superseded session: the notes batch must not go out as NEW.
    firstBatch.resolve(undefined);
    await until(() => terminal(mock));
    await expectReplacementIntact(mock, routes.calls);
    expect(ingests()).toHaveLength(1);
  }, 15000);
});

describe("negative control — current-session auth loss still clears", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ingest 401 → refresh rejected: tokens cleared, auth_required exactly once, 'session expired' state", async () => {
    const routes = makeRoutes({
      refresh: () => new Response(null, { status: 401 }),
      ingest: () => new Response(null, { status: 401 }),
    });
    const mock = await load(routes);
    await startImport(mock);
    await until(() => terminal(mock));
    expect(authRequired(mock)).toHaveLength(1);
    expect(snapshots(mock).at(-1).lastError).toBe(
      "session expired — please sign in again",
    );
    expect(mock.sessionMap.has(REFRESH_KEY)).toBe(false);
    const state = await mock.dispatch({ kind: "request_session_state" });
    expect(state).toEqual({ ok: true, hasSession: false });
  }, 15000);

  it("ingest 401 → refresh OK → retry 401: tokens cleared, auth_required exactly once", async () => {
    const routes = makeRoutes({
      refresh: () =>
        Response.json({
          access_token: "OLD_MINTED_ACCESS",
          refresh_token: "OLD_ROTATED",
        }),
      ingest: () => new Response(null, { status: 401 }),
    });
    const mock = await load(routes);
    await startImport(mock);
    await until(() => terminal(mock));
    expect(authRequired(mock)).toHaveLength(1);
    expect(snapshots(mock).at(-1).lastError).toBe(
      "session expired — please sign in again",
    );
    expect(mock.sessionMap.has(REFRESH_KEY)).toBe(false);
    const bearers = routes.calls
      .filter((c) => c.url === INGEST_URL)
      .map((c) => c.authorization);
    expect(bearers).toEqual([
      `Bearer ${OLD.accessToken}`,
      "Bearer OLD_MINTED_ACCESS",
    ]);
  }, 15000);
});
