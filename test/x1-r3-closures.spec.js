import { describe, it, expect, vi } from "vitest";
import {
  makeBgMock,
  installChrome,
  acceptedIngest,
} from "./helpers/background-mock.js";
import { fakePageStore, realSourceTab } from "./helpers/source-tab.js";

// PR #35 round 3: every test here FAILS on 142501a (the r2 head), where
//   R35-A-01  Network.enable ran on whatever origin the tab held after attach;
//   R35-A-02  a fresh grant was consumed by whichever Start message came next;
//   R35-A-03  a revocation during terminal settlement still reported success;
//   R35-A-04 / R35B-B3  the popup prompted BEFORE it registered, so a popup the
//             prompt closed left a grant with no run, and a cold worker that
//             saw the message first revoked the grant it was about to receive;
//   R35B-B1   a grant survived a refused Start and a worker death;
//   R35B-B2   any foreign documentURL (an about:blank iframe) killed capture,
//             and stop_capture then reported zero entries with no reason.

vi.setConfig({ testTimeout: 30000 });

const REFRESH_KEY = "tgp_refresh_token";
const REFRESH_URL =
  "https://backend-spring-lake-3890.fly.dev/api/auth/extension/refresh";
const INGEST_URL = "https://backend-spring-lake-3890.fly.dev/api/scout/ingest";
const COMPLETE_URL =
  "https://backend-spring-lake-3890.fly.dev/api/scout/ingest/complete";
const PROGRESS_URL =
  "https://backend-spring-lake-3890.fly.dev/api/scout/progress";
const SRC_BASE = "https://app.truecoach.co/proxy/api";
const CLIENTS_PREFIX = `${SRC_BASE}/clients?`;
const TAB_URL = "https://app.truecoach.co/clients?client=jane.doe";
const ORIGIN = "https://app.truecoach.co";
const OTHER = "https://other.example";
const TAB_ID = 42;
const SRC_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb2FjaCJ9.s1g-nature_TOKEN";
const EXT_ID = "test-extension-id";

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

function sourceFetches() {
  // @ts-expect-error -- vi.fn on global.fetch
  return global.fetch.mock.calls.filter(([url]) =>
    String(url).startsWith(SRC_BASE),
  );
}

function routeSuccess(
  mock,
  { onClients = async () => {}, onComplete = async () => {} } = {},
) {
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
      await onComplete();
      completes.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    }
    throw new Error(`unrouted fetch ${url}`);
  });
  return { completes };
}

describe("R35-A-02 / R35B-B3 — a Start is one nonce, one tab, one origin, either order", () => {
  it("the grant arriving BEFORE the popup's message still starts the run", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    routeSuccess(mock);
    const ack = await mock.dispatchGrantFirst({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "n1",
    });
    expect(ack).toEqual({ ok: true });
    expect(await settle(mock)).toBe("ingest_succeeded");
    await flush();
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
  });

  it("the popup's message arriving BEFORE the grant starts the run (popup may be gone)", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    routeSuccess(mock);
    // Registration only: no prompt answer yet.
    const ack = await mock.dispatchRaw({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "n2",
    });
    expect(ack).toEqual({ ok: true });
    await flush();
    expect(sourceFetches()).toHaveLength(0);
    // Chrome's prompt closed the popup; the grant event is all that arrives.
    mock.grantArrives(ORIGIN);
    expect(await settle(mock)).toBe("ingest_succeeded");
  });

  it("a later message from a different tab cannot ride a grant another Start earned", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    routeSuccess(mock);
    // Tab 42 registered. The grant for ORIGIN arrives. Meanwhile a message for
    // tab 7 (same origin) lands: the run must use tab 42, never tab 7.
    await mock.dispatchRaw({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "n3",
    });
    mock.grantArrives(ORIGIN);
    const busy = await mock.dispatchRaw({
      kind: "start_import",
      url: `${ORIGIN}/other`,
      tabId: 7,
      nonce: "n4",
    });
    expect(busy).toEqual({ ok: false, error: "import_in_progress" });
    expect(await settle(mock)).toBe("ingest_succeeded");
    expect(mock.scripting.executed).toEqual([
      { target: { tabId: TAB_ID }, files: ["content/main.js"] },
    ]);
  });

  it("a grant for a different origin than the pending Start is revoked and refused with a stable code", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    await mock.dispatchRaw({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "n5",
    });
    mock.grantArrives(OTHER);
    await flush();
    expect(mock.grants.has(`${OTHER}/*`)).toBe(false);
    expect(snapshots(mock).at(-1).lastError).toBe(
      `start_grant_mismatch: ${OTHER}`,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("a pending Start that never gets its grant expires, and a grant that never gets its Start is revoked", async () => {
    vi.useFakeTimers();
    try {
      const { mock } = await load({ tab: withSourceTab() });
      await mock.dispatchRaw({
        kind: "start_import",
        url: TAB_URL,
        tabId: TAB_ID,
        nonce: "n6",
      });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(snapshots(mock).at(-1).lastError).toBe(`start_expired: ${ORIGIN}`);
      // Now a lone grant with no registration behind it.
      mock.grantArrives(OTHER);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(mock.grants.has(`${OTHER}/*`)).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("start_unavailable with the wrong nonce cancels nothing", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    routeSuccess(mock);
    await mock.dispatchRaw({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "n7",
    });
    const bad = await mock.dispatchRaw({
      kind: "start_unavailable",
      nonce: "someone-else",
    });
    expect(bad).toEqual({ ok: false, error: "no_pending_start" });
    mock.grantArrives(ORIGIN);
    expect(await settle(mock)).toBe("ingest_succeeded");
  });
});

describe("R35-A-03 — revocation during terminal settlement never yields success", () => {
  it("start_import: the grant goes while /complete is in flight → ingest_failed, origin_revoked", async () => {
    const { mock, sessionModule } = await load({ tab: withSourceTab() });
    routeSuccess(mock, {
      onComplete: async () => {
        await mock.chrome.permissions.remove({ origins: [`${ORIGIN}/*`] });
        await flush(2);
      },
    });
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    expect(await settle(mock)).toBe("ingest_failed");
    expect(snapshots(mock).at(-1).lastError).toBe(`origin_revoked: ${ORIGIN}`);
    expect(
      snapshots(mock).some((s) => s.intent?.status === "ingest_succeeded"),
    ).toBe(false);
    expect(sessionModule.getAuthorizedOrigin()).toBeNull();
  });
});

describe("R35B-B1 — grants never outlive the run", () => {
  it("P3: a Start refused as busy leaves no grant behind after the running import settles", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((r) => {
      release = () => r(undefined);
    });
    routeSuccess(mock, { onClients: () => gate });
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    await flush();
    // A second Start for another origin while the first is in flight. Chrome
    // would have prompted and granted; the worker refuses AND revokes.
    const refused = await mock.dispatchRaw({
      kind: "start_import",
      url: `${OTHER}/x`,
      tabId: 9,
      nonce: "busy",
    });
    expect(refused).toEqual({ ok: false, error: "import_in_progress" });
    mock.grantArrives(OTHER);
    await flush();
    expect(mock.grants.has(`${OTHER}/*`)).toBe(false);
    release();
    expect(await settle(mock)).toBe("ingest_succeeded");
    await flush();
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
    expect(mock.grants.has(`${OTHER}/*`)).toBe(false);
  });

  it("a fresh worker removes every optional host grant a dead worker left, before any Start", async () => {
    const { mock } = await load({
      tab: withSourceTab(),
      held: [`${ORIGIN}/*`, `${OTHER}/*`],
    });
    routeSuccess(mock);
    await flush();
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
    expect(mock.grants.has(`${OTHER}/*`)).toBe(false);
    expect(mock.permissionRemovals).toContainEqual({
      origins: [`${ORIGIN}/*`],
    });
    expect(mock.permissionRemovals).toContainEqual({
      origins: [`${OTHER}/*`],
    });
    // The required TGP host is never touched.
    for (const r of mock.permissionRemovals) {
      expect(r.origins).not.toContain(
        "https://backend-spring-lake-3890.fly.dev/*",
      );
    }
    // And a proper Start still works afterwards.
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    expect(await settle(mock)).toBe("ingest_succeeded");
  });

  it("when the startup sweep cannot read grants, Start is refused (cleanup_pending) until a retry verifies", async () => {
    const { mock } = await load({
      tab: withSourceTab(),
      held: [`${OTHER}/*`],
      failGetAll: true,
    });
    routeSuccess(mock);
    await flush();
    const refused = await mock.dispatchRaw({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "s1",
    });
    expect(refused).toEqual({ ok: false, error: "cleanup_pending" });
    await flush();
    // Chrome recovers; the refused Start retried the sweep and verified it.
    mock.knobs.failGetAll = false;
    const retrying = await mock.dispatchRaw({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "s2",
    });
    expect(retrying).toEqual({ ok: false, error: "cleanup_pending" });
    await flush();
    expect(mock.grants.has(`${OTHER}/*`)).toBe(false);
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    expect(await settle(mock)).toBe("ingest_succeeded");
  });
});
