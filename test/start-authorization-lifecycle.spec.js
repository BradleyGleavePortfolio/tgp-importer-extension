import { describe, it, expect, vi } from "vitest";
import {
  makeBgMock,
  installChrome,
  acceptedIngest,
} from "./helpers/background-mock.js";
import { fakePageStore, realSourceTab } from "./helpers/source-tab.js";

// The lifetime of a Start authorization, end to end through background.js
// (review A: B1, B2, A2-token; review B: B1, B3, B4). Every test here FAILS on
// 7ac1fe9, where a durable grant passed for a Start, cleanup failures were
// logged and forgotten, the tab was checked once before the collector ran,
// `start_ingest` accepted a caller-supplied bearer, a revoked grant was not
// noticed until the next admission, and a restarted worker never removed the
// collector its predecessor registered.

// Shared machine: the first import of the worker module graph and the legacy
// extractor's paced walk are load-sensitive, not slow by design.
vi.setConfig({ testTimeout: 30000 });

const REFRESH_KEY = "tgp_refresh_token";
const REFRESH_URL = "https://api.tgp.coach/api/auth/extension/refresh";
const INGEST_URL = "https://api.tgp.coach/api/scout/ingest";
const COMPLETE_URL = "https://api.tgp.coach/api/scout/ingest/complete";
const PROGRESS_URL = "https://api.tgp.coach/api/scout/progress";
const SRC_BASE = "https://app.truecoach.co/proxy/api";
const CLIENTS_PREFIX = `${SRC_BASE}/clients?`;
const TAB_URL = "https://app.truecoach.co/clients?client=jane.doe";
const ORIGIN = "https://app.truecoach.co";
const OTHER = "https://other.example";
const TAB_ID = 42;
const SRC_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb2FjaCJ9.s1g-nature_TOKEN";
const EXT_ID = "test-extension-id";
const COLLECTOR_ID = "tgp-source-collector";

function withSourceTab(opts = {}) {
  const stores = [fakePageStore(), fakePageStore([["truecoach.jwt", SRC_JWT]])];
  return { url: TAB_URL, sendMessage: realSourceTab(EXT_ID, stores), ...opts };
}

async function load(options = {}) {
  vi.resetModules();
  const mock = makeBgMock({
    session: new Map([[REFRESH_KEY, "seed-refresh"]]),
    ...options,
  });
  installChrome(mock);
  global.fetch = vi.fn();
  const sessionModule = await import("../shared/session.js");
  await import("../background.js");
  return { mock, sessionModule };
}

function flush(n = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i += 1) {
    p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  }
  return p;
}

function snapshots(mock) {
  return mock.sent.filter((m) => m && m.kind === "status_snapshot");
}

// Terminal status of the run admitted AFTER `mark` snapshots had been sent
// (so an earlier run's terminal snapshot is never mistaken for this one's),
// followed by a flush so the run's settlement has completed before the test
// moves on. Returns null when nothing terminal arrived within `ms`.
async function settle(mock, ms = 10000, mark = 0) {
  const start = Date.now();
  for (;;) {
    const last = snapshots(mock).slice(mark).at(-1);
    const status = last && last.intent ? last.intent.status : null;
    if (
      status === "ingest_succeeded" ||
      status === "ingest_failed" ||
      status === "ingest_partial"
    ) {
      await flush();
      return status;
    }
    if (Date.now() - start > ms) return status;
    await flush(2);
  }
}

// Dispatch a Start and resolve to its terminal status (see settle).
async function runToEnd(mock, message, ms = 10000) {
  const mark = snapshots(mock).length;
  const ack = await mock.dispatch(message);
  expect(ack).toEqual({ ok: true });
  return settle(mock, ms, mark);
}

// Every refused Start must leave the coach's tab and the network untouched.
function expectNothingStarted(mock) {
  expect(mock.tabMessages).toHaveLength(0);
  expect(mock.scripting.registered).toHaveLength(0);
  expect(mock.scripting.executed).toHaveLength(0);
}

function sourceFetches() {
  // @ts-expect-error -- vi.fn on global.fetch
  return global.fetch.mock.calls.filter(([url]) =>
    String(url).startsWith(SRC_BASE),
  );
}

// One client, no notes; `onClients` runs when the first source page is asked
// for (the run is provably in flight at that moment).
function routeSuccess(mock, { onClients = async () => {} } = {}) {
  const completes = [];
  // @ts-expect-error -- vi.fn on global.fetch
  global.fetch.mockImplementation(async (url, init) => {
    if (url === REFRESH_URL) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "TGP-ACCESS" }),
      };
    }
    if (url.startsWith(CLIENTS_PREFIX) && url.includes("page=1")) {
      await onClients();
      return {
        ok: true,
        status: 200,
        json: async () => ({ clients: [{ id: "c1" }] }),
      };
    }
    if (url.startsWith(CLIENTS_PREFIX)) {
      return { ok: true, status: 200, json: async () => ({ clients: [] }) };
    }
    if (url.startsWith(`${SRC_BASE}/clients/c1/`)) {
      return { ok: true, status: 200, json: async () => ({ notes: [] }) };
    }
    if (url === INGEST_URL) return acceptedIngest(init);
    if (url === PROGRESS_URL) return { ok: true, status: 204 };
    if (url === COMPLETE_URL) {
      completes.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    }
    throw new Error(`unrouted fetch ${url}`);
  });
  return { completes };
}

describe("A:B1 — a grant that merely exists is not a Start", () => {
  it("refuses a held grant with no fresh Start behind it, and revokes it so the next Start prompts again", async () => {
    // Chrome holds the origin (a past run whose revoke failed, or a lost
    // message), but no permissions.onAdded announced a Start for it.
    const { mock, sessionModule } = await load({
      tab: withSourceTab(),
      fresh: false,
    });
    const ack = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(ack).toEqual({ ok: true });
    await flush();
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toBe(`start_not_authorized: ${ORIGIN}`);
    expect(last.lastError).not.toContain("jane.doe");
    expect(mock.permissionRemovals).toEqual([{ origins: [`${ORIGIN}/*`] }]);
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expectNothingStarted(mock);
    expect(sessionModule.getAuthorizedOrigin()).toBeNull();
  });

  it("start_ingest is held to the same fresh-grant rule", async () => {
    const { mock } = await load({ tab: withSourceTab(), fresh: false });
    await mock.dispatch({ kind: "start_ingest", url: TAB_URL, tabId: TAB_ID });
    await flush();
    expect(snapshots(mock).at(-1).lastError).toBe(
      `start_not_authorized: ${ORIGIN}`,
    );
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expectNothingStarted(mock);
  });

  it("a fresh grant is consumed by its run: the same grant cannot start a second run", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    routeSuccess(mock);
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    expect(await settle(mock)).toBe("ingest_succeeded");
    await flush();
    // The run's settlement revoked the grant and verified it gone.
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
    expect(mock.permissionRemovals).toContainEqual({
      origins: [`${ORIGIN}/*`],
    });
    // Chrome still holds it (revoke raced a re-grant, say) but no Start
    // announced it: refused and revoked again.
    mock.grants.add(`${ORIGIN}/*`);
    const before = sourceFetches().length;
    await mock.dispatchRaw({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    await flush();
    expect(snapshots(mock).at(-1).lastError).toBe(
      `start_not_authorized: ${ORIGIN}`,
    );
    expect(sourceFetches().length).toBe(before);
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
  });
});

describe("A:B2 — cleanup is verified, never assumed", () => {
  it("a collector unregister failure keeps the Start gate closed (cleanup_pending) until a retry verifies removal", async () => {
    const { mock } = await load({ tab: withSourceTab(), failUnregister: true });
    routeSuccess(mock);
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    expect(await settle(mock)).toBe("ingest_succeeded");
    await flush();
    // The registration is still there: Chrome refused to remove it.
    expect(mock.registeredIds.has(COLLECTOR_ID)).toBe(true);
    // No run is admitted while the previous run's cleanup is owed.
    const refused = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(refused).toEqual({ ok: false, error: "cleanup_pending" });
    await flush();
    expect(mock.registeredIds.has(COLLECTOR_ID)).toBe(true);
    // Chrome recovers; the refused Start retried the cleanup and verified it.
    mock.knobs.failUnregister = false;
    const retrying = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(retrying).toEqual({ ok: false, error: "cleanup_pending" });
    await flush();
    expect(mock.registeredIds.has(COLLECTOR_ID)).toBe(false);
    expect(
      await runToEnd(mock, {
        kind: "start_import",
        url: TAB_URL,
        tabId: TAB_ID,
      }),
    ).toBe("ingest_succeeded");
  });

  it("a grant revoke failure keeps the Start gate closed until the grant is verified gone", async () => {
    const { mock } = await load({ tab: withSourceTab(), failRevoke: true });
    routeSuccess(mock);
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    expect(await settle(mock)).toBe("ingest_succeeded");
    await flush();
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(true);
    const refused = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(refused).toEqual({ ok: false, error: "cleanup_pending" });
    mock.knobs.failRevoke = false;
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    await flush();
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
    expect(
      await runToEnd(mock, {
        kind: "start_import",
        url: TAB_URL,
        tabId: TAB_ID,
      }),
    ).toBe("ingest_succeeded");
  });
});

describe("A:A2 — the source token is bound to one document", () => {
  it("a tab that navigates during collector injection starts nothing: source_tab_navigated", async () => {
    const tab = withSourceTab();
    const { mock } = await load({ tab });
    routeSuccess(mock);
    // Chrome also holds the other origin (a previous run), so a grant check
    // alone would pass for the document the tab lands on.
    mock.grants.add(`${OTHER}/*`);
    const inject = mock.chrome.scripting.executeScript;
    mock.chrome.scripting.executeScript = async (injection) => {
      const result = await inject(injection);
      tab.url = `${OTHER}/landing`;
      return result;
    };
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    await flush();
    expect(snapshots(mock).at(-1).lastError).toBe(
      `source_tab_navigated: ${ORIGIN}`,
    );
    // The collector was never asked for a token, and no source request left.
    expect(mock.tabMessages).toHaveLength(0);
    expect(sourceFetches()).toHaveLength(0);
  });

  it("a token reply from a document on another origin is refused outright", async () => {
    const stores = [
      fakePageStore(),
      fakePageStore([["truecoach.jwt", SRC_JWT]]),
    ];
    const { mock } = await load({
      tab: {
        url: TAB_URL,
        // The real collector answers, but from a document on OTHER.
        sendMessage: realSourceTab(EXT_ID, stores, EXT_ID, `${OTHER}/app`),
      },
    });
    routeSuccess(mock);
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    await flush();
    expect(snapshots(mock).at(-1).lastError).toBe(
      `source_tab_navigated: ${ORIGIN}`,
    );
    expect(sourceFetches()).toHaveLength(0);
  });

  it("start_ingest refuses a caller-supplied source token", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    routeSuccess(mock);
    await mock.dispatch({
      kind: "start_ingest",
      url: TAB_URL,
      tabId: TAB_ID,
      sourceToken: "attacker.supplied.TOKEN",
    });
    await flush();
    expect(snapshots(mock).at(-1).lastError).toBe(
      `source_token_not_accepted: ${ORIGIN}`,
    );
    expect(sourceFetches()).toHaveLength(0);
    expectNothingStarted(mock);
  });
});

describe("B:B1 — revoking the grant mid-run stops the run now", () => {
  it("aborts the crawl, drops the authorization, settles failed and reports origin_revoked", async () => {
    const { mock, sessionModule } = await load({ tab: withSourceTab() });
    const { completes } = routeSuccess(mock, {
      onClients: async () => {
        // The coach removes site access while the first page is in flight.
        await mock.chrome.permissions.remove({ origins: [`${ORIGIN}/*`] });
      },
    });
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    expect(await settle(mock)).toBe("ingest_failed");
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toBe(`origin_revoked: ${ORIGIN}`);
    // Only the page that was in flight when the grant went; nothing after it.
    expect(sourceFetches()).toHaveLength(1);
    expect(sessionModule.getAuthorizedOrigin()).toBeNull();
    // The TGP session is intact, so the intent is settled honestly.
    expect(completes).toHaveLength(1);
    expect(completes[0].terminal_status).toBe("failed");
    expect(completes[0].error_summary).toBe(`origin_revoked: ${ORIGIN}`);
    // And no Start can ride the run's old authorization afterwards.
    await flush();
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
  });

  it("start_ingest: the legacy extractor stops on revocation too", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    let sourceCalls = 0;
    // @ts-expect-error -- vi.fn on global.fetch
    global.fetch.mockImplementation(async (url, init) => {
      if (url === REFRESH_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "TGP-ACCESS" }),
        };
      }
      if (String(url).startsWith(SRC_BASE)) {
        sourceCalls += 1;
        await mock.chrome.permissions.remove({ origins: [`${ORIGIN}/*`] });
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({}),
          text: async () => "{}",
        };
      }
      if (url === INGEST_URL) return acceptedIngest(init);
      if (url === COMPLETE_URL) return { ok: true, status: 200 };
      throw new Error(`unrouted fetch ${url}`);
    });
    await mock.dispatch({ kind: "start_ingest", url: TAB_URL, tabId: TAB_ID });
    expect(await settle(mock, 20000)).toBe("ingest_failed");
    expect(snapshots(mock).at(-1).lastError).toBe(`origin_revoked: ${ORIGIN}`);
    expect(sourceCalls).toBe(1);
  });

  it("a revocation while the token is being collected starts nothing", async () => {
    const tab = withSourceTab();
    const { mock } = await load({ tab });
    routeSuccess(mock);
    const inject = mock.chrome.scripting.executeScript;
    mock.chrome.scripting.executeScript = async (injection) => {
      await mock.chrome.permissions.remove({ origins: [`${ORIGIN}/*`] });
      return inject(injection);
    };
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    await flush();
    expect(snapshots(mock).at(-1).lastError).toBe(`origin_revoked: ${ORIGIN}`);
    expect(sourceFetches()).toHaveLength(0);
  });
});

describe("B:B3 / B:B4 — a fresh worker inherits nothing", () => {
  it("removes a collector registration a previous worker left behind, at startup", async () => {
    const { mock } = await load({ registered: [COLLECTOR_ID] });
    await flush();
    expect(
      mock.scripting.unregistered.some((f) => f.ids.includes(COLLECTOR_ID)),
    ).toBe(true);
    expect(mock.registeredIds.has(COLLECTOR_ID)).toBe(false);
  });

  it("holds the Start gate closed when that startup removal fails, until a retry succeeds", async () => {
    const { mock } = await load({
      registered: [COLLECTOR_ID],
      failUnregister: true,
      tab: withSourceTab(),
    });
    await flush();
    expect(mock.registeredIds.has(COLLECTOR_ID)).toBe(true);
    const refused = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(refused).toEqual({ ok: false, error: "cleanup_pending" });
    mock.knobs.failUnregister = false;
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    await flush();
    expect(mock.registeredIds.has(COLLECTOR_ID)).toBe(false);
    routeSuccess(mock);
    expect(
      await runToEnd(mock, {
        kind: "start_import",
        url: TAB_URL,
        tabId: TAB_ID,
      }),
    ).toBe("ingest_succeeded");
  });

  it("a restarted worker holds no authorized origin, resumes nothing and refuses capture", async () => {
    // Worker 1 authorizes and runs.
    const first = await load({ tab: withSourceTab() });
    routeSuccess(first.mock);
    await first.mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(await settle(first.mock)).toBe("ingest_succeeded");
    // Worker 2 (Chrome recycled the service worker): fresh module graph, same
    // chrome.storage.session contents.
    const second = await load({
      session: new Map(first.mock.sessionMap),
      tab: withSourceTab(),
    });
    await flush();
    expect(second.sessionModule.getAuthorizedOrigin()).toBeNull();
    expect(snapshots(second.mock).some((s) => s.intent !== null)).toBe(false);
    const capture = await second.mock.dispatch({
      kind: "start_capture",
      tabId: TAB_ID,
    });
    expect(capture).toEqual({
      ok: false,
      error: "capture_origin_not_authorized",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("granted for one origin, Start on another: origin_not_granted for the other", async () => {
    // Chrome holds a grant for ORIGIN only; the coach's tab is on OTHER and no
    // prompt is accepted for it.
    const { mock } = await load({
      granted: false,
      tab: { url: `${OTHER}/app`, token: SRC_JWT },
    });
    mock.grants.add(`${ORIGIN}/*`);
    await mock.dispatch({
      kind: "start_import",
      url: `${OTHER}/app`,
      tabId: TAB_ID,
    });
    await flush();
    expect(snapshots(mock).at(-1).lastError).toBe(
      `origin_not_granted: ${OTHER}`,
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expectNothingStarted(mock);
  });
});
