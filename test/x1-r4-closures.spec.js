import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeBgMock,
  installChrome,
  acceptedIngest,
} from "./helpers/background-mock.js";
import { fakePageStore, realSourceTab } from "./helpers/source-tab.js";
import { preStartIssue } from "../popup/outcome.js";

// PR #35 round 4: closures for the c7 audits of bd1684ae. Every behavioural
// test here FAILS on bd1684ae (the r3 head), where
//   R35-c7A-01  a closed Start tab did not end the run or revoke its grant,
//               and a Start with no tab id ran a cookie-only replay;
//   R35-c7A-02  a grant lost while /complete was in flight made the extension
//               report `failed` over a terminal the backend had committed;
//   R35-c7A-03  a permissions.contains fault read as "grant gone";
//   R35-c7A-04  the collector's reply was not addressed to one document;
//   R35-c7B-01  the manifest kept `activeTab`;
//   R35-c7B-02  a claimed Start could be cancelled by a late popup message;
//   R35-c7B-04  nothing kept the worker alive through Chrome's prompt;
//   R35-c7B-05  a TGP session clear mid-run was reported as `origin_revoked`;
//   R35-c7B-09  `start_superseded` and friends had no popup copy.

vi.setConfig({ testTimeout: 30000 });

const root = fileURLToPath(new URL("..", import.meta.url));
const REFRESH_KEY = "tgp_refresh_token";
const API = "https://backend-spring-lake-3890.fly.dev";
const REFRESH_URL = `${API}/api/auth/extension/refresh`;
const INGEST_URL = `${API}/api/scout/ingest`;
const COMPLETE_URL = `${API}/api/scout/ingest/complete`;
const PROGRESS_URL = `${API}/api/scout/progress`;
const STATUS_URL = `${API}/api/scout/import/status`;
const SRC_BASE = "https://app.truecoach.co/proxy/api";
const CLIENTS_PREFIX = `${SRC_BASE}/clients?`;
const TAB_URL = "https://app.truecoach.co/clients?client=jane.doe";
const ORIGIN = "https://app.truecoach.co";
const OTHER = "https://other.example";
const TAB_ID = 42;
const SRC_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb2FjaCJ9.s1g-nature_TOKEN";
const EXT_ID = "test-extension-id";
const SESSION_REPLACED_DETAIL =
  "import stopped — your TGP session changed during the import. Start the import again.";

function withSourceTab(opts = {}) {
  const stores = [fakePageStore(), fakePageStore([["truecoach.jwt", SRC_JWT]])];
  return { url: TAB_URL, sendMessage: realSourceTab(EXT_ID, stores), ...opts };
}

/**
 * @param {Record<string, unknown>} [options]
 * @param {(mock: ReturnType<typeof makeBgMock>) => void} [beforeImport]
 */
async function load(options = {}, beforeImport = () => {}) {
  vi.resetModules();
  const mock = makeBgMock({
    session: new Map([[REFRESH_KEY, "seed-refresh"]]),
    ...options,
  });
  installChrome(mock);
  global.fetch = vi.fn();
  beforeImport(mock);
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

// Poll a condition on real time rather than counting macrotasks: the worker's
// async depth is not the test's business, and load must not turn a fixed
// count into a flake.
async function waitUntil(predicate, ms = 5000) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > ms) return;
    await flush(1);
  }
}

function lastErrorIs(mock, prefix) {
  return () =>
    String(snapshots(mock).at(-1)?.lastError ?? "").startsWith(prefix);
}

async function settle(mock, ms = 10000) {
  const start = Date.now();
  for (;;) {
    const last = snapshots(mock).at(-1);
    const status = last && last.intent ? last.intent.status : null;
    if (
      status === "ingest_succeeded" ||
      status === "ingest_failed" ||
      status === "ingest_partial" ||
      status === "ingest_unconfirmed"
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

// Routes: a one-client source, TGP ingest/progress, /complete (hookable, may
// fail), and GET /import/status answering from `serverStatus(intentId)`
// (null -> 404 "not yet known"; undefined fn -> always 404).
function route(
  mock,
  {
    onClients = async () => {},
    onComplete = async () => {},
    completeStatus = 200,
    serverStatus = undefined,
  } = {},
) {
  const completes = [];
  const statusReads = [];
  // @ts-expect-error -- vi.fn on global.fetch
  global.fetch.mockImplementation(async (url, init) => {
    if (String(url).startsWith(STATUS_URL)) {
      const intentId = new URL(url).searchParams.get("intent_id");
      statusReads.push(intentId);
      const answer = serverStatus === undefined ? null : serverStatus(intentId);
      if (answer === null) return { ok: false, status: 404 };
      return Response.json({
        intent_id: intentId,
        status: answer.status,
        mode: "server",
        completed_at:
          answer.status === "running" ? null : "2026-09-29T18:00:00Z",
        entity_counts: (answer.counts ?? []).map(
          ([entity_type, committed]) => ({
            entity_type,
            committed,
          }),
        ),
      });
    }
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
      return { ok: completeStatus < 400, status: completeStatus };
    }
    throw new Error(`unrouted fetch ${url}`);
  });
  return { completes, statusReads };
}

function start(mock, extra = {}) {
  return mock.dispatch({
    kind: "start_import",
    url: TAB_URL,
    tabId: TAB_ID,
    ...extra,
  });
}

describe("R35-c7A-01 — the Start capability never outlives its tab", () => {
  it("a Start with no tab id is refused before anything is registered or prompted (worker side)", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock);
    for (const tabId of [undefined, null, "42"]) {
      const ack = await mock.dispatchRaw({
        kind: "start_import",
        url: TAB_URL,
        tabId,
        nonce: `n-${String(tabId)}`,
      });
      expect(ack).toEqual({ ok: false, error: "source_tab_required" });
    }
    // Chrome then delivers a grant anyway (the popup must not prompt, but a
    // grant from Chrome's own UI could): nothing is pending, so it is held
    // for the window only and no run ever starts.
    mock.grantArrives(ORIGIN);
    await flush(10);
    expect(sourceFetches()).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mock.scripting.executed).toEqual([]);
  });

  it("start_ingest is held to the same rule", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock);
    const ack = await mock.dispatchRaw({ kind: "start_ingest", url: TAB_URL });
    expect(ack).toEqual({ ok: false, error: "source_tab_required" });
    await flush();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("the Start tab closes while the prompt is open: the pending Start ends and the late grant is revoked", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock);
    const ack = await mock.dispatchRaw({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "closed-before-grant",
    });
    expect(ack).toEqual({ ok: true });
    mock.closeTab(TAB_ID);
    await waitUntil(lastErrorIs(mock, "source_tab_closed"));
    expect(snapshots(mock).at(-1).lastError).toBe(
      `source_tab_closed: ${ORIGIN}`,
    );
    // The coach accepted the prompt after the tab was already gone.
    mock.grantArrives(ORIGIN);
    await waitUntil(() => !mock.grants.has(`${ORIGIN}/*`));
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
    expect(sourceFetches()).toHaveLength(0);
    expect(mock.scripting.executed).toEqual([]);
  });

  it("another tab closing does not touch the pending Start", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock);
    await mock.dispatchRaw({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "other-tab",
    });
    mock.closeTab(TAB_ID + 1);
    mock.grantArrives(ORIGIN);
    expect(await settle(mock)).toBe("ingest_succeeded");
  });

  it("the Start tab closes during token collection: nothing starts, the grant is revoked", async () => {
    const tab = withSourceTab();
    const { mock } = await load({ tab });
    route(mock);
    const inject = mock.chrome.scripting.executeScript;
    mock.chrome.scripting.executeScript = async (injection) => {
      mock.closeTab(TAB_ID);
      return inject(injection);
    };
    await start(mock);
    await waitUntil(lastErrorIs(mock, "source_tab_closed"));
    expect(snapshots(mock).at(-1).lastError).toBe(
      `source_tab_closed: ${ORIGIN}`,
    );
    expect(sourceFetches()).toHaveLength(0);
    expect(snapshots(mock).some((s) => s.intent !== null)).toBe(false);
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
  });

  it("the Start tab closes during replay: the run stops now, settles failed as source_tab_closed, the grant is revoked", async () => {
    const { mock, sessionModule } = await load({ tab: withSourceTab() });
    const { completes } = route(mock, {
      onClients: async () => {
        mock.closeTab(TAB_ID);
        await flush(2);
      },
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_failed");
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toBe(`source_tab_closed: ${ORIGIN}`);
    // Only the page in flight when the tab went; nothing after it.
    expect(sourceFetches()).toHaveLength(1);
    expect(sessionModule.getAuthorizedOrigin()).toBeNull();
    expect(completes).toHaveLength(1);
    expect(completes[0].terminal_status).toBe("failed");
    expect(completes[0].error_summary).toBe(`source_tab_closed: ${ORIGIN}`);
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
    // Never reported as a permission problem.
    expect(
      snapshots(mock).some((s) =>
        String(s.lastError).startsWith("origin_revoked"),
      ),
    ).toBe(false);
  });

  it("the Start tab leaves its origin during replay: the run stops as source_tab_navigated; a same-origin navigation does not", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    const { completes } = route(mock, {
      onClients: async () => {
        mock.navigateTab(TAB_ID, `${ORIGIN}/clients/other`);
        await flush(1);
        mock.navigateTab(TAB_ID, `${OTHER}/landing`);
        await flush(2);
      },
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_failed");
    expect(snapshots(mock).at(-1).lastError).toBe(
      `source_tab_navigated: ${ORIGIN}`,
    );
    expect(sourceFetches()).toHaveLength(1);
    expect(completes[0].error_summary).toBe(`source_tab_navigated: ${ORIGIN}`);
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
  });

  it("a same-origin navigation alone keeps the run", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock, {
      onClients: async () => {
        mock.navigateTab(TAB_ID, `${ORIGIN}/clients/other`);
        await flush(2);
      },
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_succeeded");
  });
});

describe("R35-c7A-02 — once /complete is attempted, the server's status is the result", () => {
  it("grant revoked while /complete is in flight, backend committed partial → ingest_partial shown, no failed terminal sent", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    const { completes, statusReads } = route(mock, {
      onComplete: async () => {
        await mock.chrome.permissions.remove({ origins: [`${ORIGIN}/*`] });
        await flush(2);
      },
      serverStatus: () => ({ status: "partial", counts: [["clients", 1]] }),
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_partial");
    const last = snapshots(mock).at(-1);
    expect(last.serverTerminal).toBe("partial");
    expect(last.lastError).toBeNull();
    expect(completes.map((c) => c.terminal_status)).toEqual(["success"]);
    expect(statusReads).toHaveLength(1);
  });

  it("Start tab closed while /complete is in flight, backend committed success → the server's success is shown", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    const { completes } = route(mock, {
      onComplete: async () => {
        mock.closeTab(TAB_ID);
        await flush(2);
      },
      serverStatus: () => ({ status: "success", counts: [["clients", 1]] }),
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_succeeded");
    expect(snapshots(mock).at(-1).serverTerminal).toBe("success");
    expect(completes.map((c) => c.terminal_status)).toEqual(["success"]);
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
  });

  it("grant revoked while /complete is in flight, backend committed failed → the server's failed is shown with the honest local reason", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock, {
      onComplete: async () => {
        await mock.chrome.permissions.remove({ origins: [`${ORIGIN}/*`] });
        await flush(2);
      },
      serverStatus: () => ({ status: "failed" }),
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_failed");
    const last = snapshots(mock).at(-1);
    expect(last.serverTerminal).toBe("failed");
    expect(last.lastError).toBe(`origin_revoked: ${ORIGIN}`);
  });

  it("grant revoked and /complete rejected, server has no terminal → unconfirmed, and NO second terminal is sent over it", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    const { completes, statusReads } = route(mock, {
      onComplete: async () => {
        await mock.chrome.permissions.remove({ origins: [`${ORIGIN}/*`] });
        await flush(2);
      },
      completeStatus: 503,
      serverStatus: () => ({ status: "running" }),
    });
    await start(mock);
    // r5 (S1-A2): an unconfirmed terminal is its own state, no longer shown
    // as `ingest_failed` — the server has not said failed.
    expect(await settle(mock)).toBe("ingest_unconfirmed");
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toBe(
      `complete_unconfirmed: origin_revoked: ${ORIGIN}`,
    );
    expect(last.serverStatus).toBe("running");
    expect(last.serverTerminal).toBeUndefined();
    expect(
      snapshots(mock).some((s) => s.intent?.status === "ingest_failed"),
    ).toBe(false);
    // Our one attempted terminal only; the revocation did not POST `failed`.
    expect(completes.map((c) => c.terminal_status)).toEqual(["success"]);
    expect(statusReads).toHaveLength(1);
    expect(
      snapshots(mock).some((s) => s.intent?.status === "ingest_succeeded"),
    ).toBe(false);
  });

  it("grant revoked, /complete acknowledged, but the status read is unavailable → the acknowledged outcome is shown (the ack IS the server's answer)", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    const { completes } = route(mock, {
      onComplete: async () => {
        await mock.chrome.permissions.remove({ origins: [`${ORIGIN}/*`] });
        await flush(2);
      },
      serverStatus: undefined, // 404: not yet known
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_succeeded");
    expect(snapshots(mock).at(-1).serverTerminal).toBe("success");
    expect(completes.map((c) => c.terminal_status)).toEqual(["success"]);
  });

  it("revocation BEFORE /complete still settles failed honestly (unchanged r3 property)", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    const { completes } = route(mock, {
      onClients: async () => {
        await mock.chrome.permissions.remove({ origins: [`${ORIGIN}/*`] });
      },
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_failed");
    expect(snapshots(mock).at(-1).lastError).toBe(`origin_revoked: ${ORIGIN}`);
    expect(completes.map((c) => c.terminal_status)).toEqual(["failed"]);
  });
});

describe("R35-c7A-03 — a permissions fault is never mistaken for a verified revocation", () => {
  it("contains() throwing during settlement keeps the Start gate closed (cleanup_pending) until a read verifies", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock, {
      onComplete: async () => {
        mock.knobs.failContains = true;
      },
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_succeeded");
    await waitUntil(() => mock.permissionRemovals.length > 0);
    await flush(20);
    // The removal itself worked in Chrome, but the worker could not VERIFY
    // it: the gate stays closed rather than assumed clean.
    const refused = await mock.dispatchRaw({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "after-fault",
    });
    expect(refused).toEqual({ ok: false, error: "cleanup_pending" });
    mock.knobs.failContains = false;
    await flush(20);
    const admitted = await start(mock);
    expect(admitted).toEqual({ ok: true });
    expect(await settle(mock)).toBe("ingest_succeeded");
  });

  it("a remove() that resolves but leaves the grant held is caught by the verification read", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock, {
      onComplete: async () => {
        mock.knobs.ignoreRemove = true;
      },
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_succeeded");
    await waitUntil(() => mock.permissionRemovals.length > 0);
    await flush(20);
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(true); // Chrome kept it
    const refused = await mock.dispatchRaw({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "still-held",
    });
    expect(refused).toEqual({ ok: false, error: "cleanup_pending" });
    mock.knobs.ignoreRemove = false;
    await waitUntil(() => !mock.grants.has(`${ORIGIN}/*`));
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
  });

  it("contains() throwing at admission never authorizes a run", async () => {
    const { mock } = await load({ tab: withSourceTab(), failContains: true });
    route(mock);
    await start(mock);
    await waitUntil(lastErrorIs(mock, "origin_not_granted"));
    expect(snapshots(mock).at(-1).lastError).toBe(
      `origin_not_granted: ${ORIGIN}`,
    );
    expect(sourceFetches()).toHaveLength(0);
  });
});

describe("R35-c7A-04 — the collector's reply is bound to the injected document", () => {
  it("an injection that names no document binds nothing: the run fails closed as source_tab_navigated", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock);
    mock.chrome.scripting.executeScript = async (injection) => {
      mock.scripting.executed.push(injection);
      return [{ frameId: 0, result: null }];
    };
    await start(mock);
    await waitUntil(lastErrorIs(mock, "source_tab_navigated"));
    expect(snapshots(mock).at(-1).lastError).toBe(
      `source_tab_navigated: ${ORIGIN}`,
    );
    expect(mock.tabMessages).toHaveLength(0);
    expect(sourceFetches()).toHaveLength(0);
  });

  it("the token request is addressed to the injected document's id; a replacement document (same origin) gets no request and answers nothing", async () => {
    const stores = [
      fakePageStore(),
      fakePageStore([["truecoach.jwt", SRC_JWT]]),
    ];
    const realTab = realSourceTab(EXT_ID, stores);
    const tab = {
      url: TAB_URL,
      // Chrome delivers a documentId-addressed message only to that document;
      // after a same-origin navigation the old document is gone.
      sendMessage: (id, message, options) => {
        if (options?.documentId !== "doc-1") {
          return Promise.reject(new Error("no such document"));
        }
        return realTab(id, message);
      },
    };
    const { mock } = await load({ tab });
    route(mock);
    await start(mock);
    expect(await settle(mock)).toBe("ingest_succeeded");
    expect(mock.tabMessages).toEqual([
      {
        id: TAB_ID,
        message: { kind: "collect_source_token" },
        options: { documentId: "doc-1" },
      },
    ]);
  });
});

describe("R35-c7B-01 — the manifest's permission set is exact and holds no activeTab", () => {
  it("permissions are exactly {tabs, storage, notifications, debugger, scripting}", () => {
    const manifest = JSON.parse(
      readFileSync(join(root, "manifest.json"), "utf8"),
    );
    expect([...manifest.permissions].sort()).toEqual(
      ["debugger", "notifications", "scripting", "storage", "tabs"].sort(),
    );
    expect(manifest.permissions).not.toContain("activeTab");
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
  });
});

describe("R35-c7B-02 — a claimed Start is not cancellable by a late popup message", () => {
  it("start_unavailable / start_granted arriving while the claimed Start awaits the startup sweep neither cancel it nor revoke its grant", async () => {
    /** @type {() => void} */
    let releaseSweep = () => {};
    const sweepGate = new Promise((r) => {
      releaseSweep = () => r(undefined);
    });
    let sweepReads = 0;
    const { mock } = await load({ tab: withSourceTab() }, (m) => {
      const getAll = m.chrome.permissions.getAll;
      // Every permissions read Chrome would answer during the startup sweep
      // is held until the test releases it: the sweep is in flight for the
      // whole exchange below, so the claimed Start must WAIT on it.
      m.chrome.permissions.getAll = async () => {
        sweepReads += 1;
        await sweepGate;
        return getAll();
      };
    });
    route(mock);
    // Sweep is in flight. Register, then the grant arrives: the Start is
    // CLAIMED and waits for the sweep.
    const ack = await mock.dispatchRaw({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "claimed",
    });
    expect(ack).toEqual({ ok: true });
    mock.grantArrives(ORIGIN);
    await flush(2);
    // Late popup messages with the SAME nonce.
    const cancel = await mock.dispatchRaw({
      kind: "start_unavailable",
      nonce: "claimed",
    });
    expect(cancel).toEqual({ ok: false, error: "no_pending_start" });
    const confirm = await mock.dispatchRaw({
      kind: "start_granted",
      nonce: "claimed",
    });
    expect(confirm).toEqual({ ok: true });
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(true);
    // Nothing ran yet: the sweep still holds the gate.
    expect(sourceFetches()).toHaveLength(0);
    expect(sweepReads).toBeGreaterThan(0);
    releaseSweep();
    expect(await settle(mock)).toBe("ingest_succeeded");
    expect(
      snapshots(mock).some(
        (s) =>
          String(s.lastError).startsWith("origin_not_granted") ||
          String(s.lastError).startsWith("start_not_authorized"),
      ),
    ).toBe(false);
  });
});

describe("R35-c7B-04 — the worker stays alive for the Start window, and only then", () => {
  it("a pending Start beats an extension API call every 20 s; the beat stops when the Start clears", async () => {
    vi.useFakeTimers();
    try {
      const { mock } = await load({ tab: withSourceTab() });
      await mock.dispatchRaw({
        kind: "start_import",
        url: TAB_URL,
        tabId: TAB_ID,
        nonce: "slow-coach",
      });
      expect(mock.platformInfoCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(45_000);
      // Two beats (20 s, 40 s) inside the 60 s window: the ~30 s idle limit
      // is never reached with no activity.
      expect(mock.platformInfoCalls).toHaveLength(2);
      await mock.dispatchRaw({
        kind: "start_unavailable",
        nonce: "slow-coach",
      });
      const after = mock.platformInfoCalls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mock.platformInfoCalls).toHaveLength(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no beat runs when nothing is pending", async () => {
    vi.useFakeTimers();
    try {
      const { mock } = await load({ tab: withSourceTab() });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mock.platformInfoCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("R35-c7B-05 — a TGP session clear mid-run is a session change, not a permission loss", () => {
  it("clearTokens() during replay reports the session-changed detail, never origin_revoked, and sends no terminal", async () => {
    const { mock, sessionModule } = await load({ tab: withSourceTab() });
    const { completes } = route(mock, {
      onClients: async () => {
        await sessionModule.clearTokens();
      },
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_failed");
    expect(snapshots(mock).at(-1).lastError).toBe(SESSION_REPLACED_DETAIL);
    expect(
      snapshots(mock).some((s) =>
        String(s.lastError).startsWith("origin_revoked"),
      ),
    ).toBe(false);
    expect(completes).toHaveLength(0);
    await flush();
    expect(mock.grants.has(`${ORIGIN}/*`)).toBe(false);
  });
});

describe("R35-c7B-09 — every Start-exchange code has approved popup copy", () => {
  const en = JSON.parse(
    readFileSync(join(root, "_locales/en/messages.json"), "utf8"),
  );
  const message = (key) => en[key]?.message ?? "";
  it.each([
    ["start_superseded: https://x.example", "prestart_origin_not_authorized"],
    ["start_expired: https://x.example", "prestart_origin_not_authorized"],
    [
      "start_not_registered: https://x.example",
      "prestart_origin_not_authorized",
    ],
    [
      "start_grant_mismatch: https://x.example",
      "prestart_origin_not_authorized",
    ],
    ["source_tab_closed: https://x.example", "prestart_source_tab_changed"],
    ["source_tab_required: https://x.example", "prestart_source_tab_changed"],
    ["source_tab_required", "prestart_source_tab_changed"],
  ])("maps %j to %s (not the generic fallback)", (lastError, key) => {
    expect(preStartIssue(lastError, message)).toBe(message(key));
    expect(preStartIssue(lastError, message)).not.toBe(
      message("prestart_unknown"),
    );
  });
});
