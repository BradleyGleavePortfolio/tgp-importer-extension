import { describe, it, expect, vi } from "vitest";
import {
  makeBgMock,
  installChrome,
  acceptedIngest,
} from "./helpers/background-mock.js";
import { fakePageStore, realSourceTab } from "./helpers/source-tab.js";
import { outcomeView, preStartIssue } from "../popup/outcome.js";

// PR #35 round 5: closures for the S1 audit of 8608a0ff. Every behavioural
// test here FAILS on 8608a0ff unless marked as a pin, where
//   S1-A1  a host grant Chrome delivered with no pending Start on the worker
//          (the Start's tab closed more than 60 s earlier, the Start expired,
//          or the worker had restarted) was HELD for another 60 s instead of
//          being revoked, and a later registration for the origin could ride
//          it; the Start tab's liveness was not verified at authorization;
//   S1-A2  a /complete whose reply was lost (network error, timeout) or
//          refused was turned into a local `ingest_failed` without asking the
//          server, and `complete_unconfirmed` itself was shown as failed.

vi.setConfig({ testTimeout: 30000 });

const REFRESH_KEY = "tgp_refresh_token";
const SNAPSHOT_KEY = "tgp_status_snapshot";
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
const GRANT = `${ORIGIN}/*`;

function withSourceTab(opts = {}) {
  const stores = [fakePageStore(), fakePageStore([["truecoach.jwt", SRC_JWT]])];
  return { url: TAB_URL, sendMessage: realSourceTab(EXT_ID, stores), ...opts };
}

/** @param {Record<string, unknown>} [options] */
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

function statuses(mock) {
  return snapshots(mock)
    .map((s) => s.intent?.status)
    .filter((s) => typeof s === "string");
}

// Poll a condition on real time rather than counting macrotasks.
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

const TERMINALS = new Set([
  "ingest_succeeded",
  "ingest_failed",
  "ingest_partial",
  "ingest_empty",
  "ingest_unconfirmed",
]);

async function settle(mock, ms = 10000) {
  const start = Date.now();
  for (;;) {
    const last = snapshots(mock).at(-1);
    const status = last && last.intent ? last.intent.status : null;
    if (TERMINALS.has(status)) {
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

function timeoutError() {
  const err = new Error("fetch_timeout");
  err.name = "TimeoutError";
  return err;
}

/**
 * @typedef {{ status: string, counts?: Array<[string, number]> } | "unreachable" | null} ServerAnswer
 */
// Routes: a one-client source (or `sourceStatus` failing its first page),
// TGP ingest/progress, /complete answered by `complete` (`ok` -> 200,
// `refuse` -> 503, `lost` -> transport error, `timeout` -> deadline), and GET
// /import/status from `serverStatus(intentId)` (null -> 404; "unreachable" ->
// the read itself fails).
/**
 * @param {ReturnType<typeof makeBgMock>} mock
 * @param {{
 *   complete?: string,
 *   serverStatus?: (intentId: string | null) => ServerAnswer,
 *   sourceStatus?: number,
 *   onClients?: () => Promise<void>,
 * }} [options]
 */
function route(
  mock,
  {
    complete = "ok",
    serverStatus = () => null,
    sourceStatus = 200,
    onClients = async () => {},
  } = {},
) {
  const completes = [];
  const statusReads = [];
  // @ts-expect-error -- vi.fn on global.fetch
  global.fetch.mockImplementation(async (url, init) => {
    if (String(url).startsWith(STATUS_URL)) {
      const intentId = new URL(url).searchParams.get("intent_id");
      statusReads.push(intentId);
      const answer = serverStatus(intentId);
      if (answer === "unreachable") throw new TypeError("fetch failed");
      if (answer === null) return { ok: false, status: 404 };
      return Response.json({
        intent_id: intentId,
        status: answer.status,
        mode: "server",
        completed_at:
          answer.status === "running" ? null : "2026-09-29T18:00:00Z",
        entity_counts: (answer.counts ?? []).map(
          ([entity_type, committed]) => ({ entity_type, committed }),
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
      if (sourceStatus !== 200) {
        return {
          ok: false,
          status: sourceStatus,
          headers: new Headers({}),
          json: async () => ({}),
        };
      }
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
      if (complete === "lost") throw new TypeError("fetch failed");
      if (complete === "timeout") throw timeoutError();
      if (complete === "refuse") return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    }
    throw new Error(`unrouted fetch ${url}`);
  });
  return { completes, statusReads };
}

function register(mock, nonce, tabId = TAB_ID, url = TAB_URL) {
  return mock.dispatchRaw({ kind: "start_import", url, tabId, nonce });
}

function start(mock) {
  return mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
}

// Nothing may have started: no source page read, no collector injected, no
// run snapshot, and Chrome holds no grant for the origin.
function expectNothingStarted(mock, sessionModule) {
  expect(sourceFetches()).toHaveLength(0);
  expect(mock.scripting.executed).toEqual([]);
  expect(snapshots(mock).some((s) => s.intent !== null)).toBe(false);
  expect(mock.grants.has(GRANT)).toBe(false);
  expect(sessionModule.getAuthorizedOrigin()).toBeNull();
}

describe("S1-A1 — a grant with no live pending Start is revoked on arrival, never held", () => {
  it("the Start tab closed; the coach accepts the prompt 90 s later: the grant is revoked at once and no later Start for the origin rides it", async () => {
    vi.useFakeTimers();
    try {
      const { mock, sessionModule } = await load({ tab: withSourceTab() });
      route(mock);
      expect(await register(mock, "slow-prompt")).toEqual({ ok: true });
      mock.closeTab(TAB_ID);
      await vi.advanceTimersByTimeAsync(10);
      expect(snapshots(mock).at(-1).lastError).toBe(
        `source_tab_closed: ${ORIGIN}`,
      );
      // Well past the Start's own 60 s window (the old code forgot the loss
      // with the window and then HELD the grant for another 60 s).
      await vi.advanceTimersByTimeAsync(90_000);
      const removalsBefore = mock.permissionRemovals.length;
      mock.grantArrives(ORIGIN);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.grants.has(GRANT)).toBe(false);
      expect(mock.permissionRemovals.length).toBeGreaterThan(removalsBefore);
      expect(mock.permissionRemovals.at(-1)).toEqual({ origins: [GRANT] });
      expect(snapshots(mock).at(-1).lastError).toBe(
        `source_tab_closed: ${ORIGIN}`,
      );
      // A Start from another tab on the same origin, inside what would have
      // been the hold window, gets no free ride: it registers and waits for
      // its OWN grant, and nothing runs.
      expect(await register(mock, "other-tab", 7, `${ORIGIN}/other`)).toEqual({
        ok: true,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expectNothingStarted(mock, sessionModule);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the Start tab left its origin; the grant arrives after the window: revoked at once as source_tab_navigated", async () => {
    vi.useFakeTimers();
    try {
      const { mock, sessionModule } = await load({ tab: withSourceTab() });
      route(mock);
      await register(mock, "navigated");
      mock.navigateTab(TAB_ID, `${OTHER}/landing`);
      await vi.advanceTimersByTimeAsync(70_000);
      mock.grantArrives(ORIGIN);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.grants.has(GRANT)).toBe(false);
      expect(snapshots(mock).at(-1).lastError).toBe(
        `source_tab_navigated: ${ORIGIN}`,
      );
      expectNothingStarted(mock, sessionModule);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the pending Start expired; the grant arrives afterwards: revoked at once (start_expired), not held for a second window", async () => {
    vi.useFakeTimers();
    try {
      const { mock, sessionModule } = await load({ tab: withSourceTab() });
      route(mock);
      await register(mock, "expired");
      await vi.advanceTimersByTimeAsync(61_000);
      expect(snapshots(mock).at(-1).lastError).toBe(`start_expired: ${ORIGIN}`);
      mock.grantArrives(ORIGIN);
      // Only microtasks and zero-delay timers: no second 60 s hold may be
      // needed for the grant to go.
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.grants.has(GRANT)).toBe(false);
      expect(snapshots(mock).at(-1).lastError).toBe(`start_expired: ${ORIGIN}`);
      expectNothingStarted(mock, sessionModule);
    } finally {
      vi.useRealTimers();
    }
  });

  it("worker restart: a grant delivered to a fresh worker that holds no registration is revoked on arrival", async () => {
    // The worker that registered the Start died; Chrome starts a new one to
    // deliver the accepted grant. Nothing in it can bind the grant.
    const { mock, sessionModule } = await load({ tab: withSourceTab() });
    route(mock);
    await flush(); // startup sweep done; nothing pending
    mock.grantArrives(ORIGIN);
    await waitUntil(() => !mock.grants.has(GRANT));
    expect(mock.grants.has(GRANT)).toBe(false);
    expect(mock.permissionRemovals).toContainEqual({ origins: [GRANT] });
    expect(snapshots(mock).at(-1).lastError).toBe(
      `start_not_registered: ${ORIGIN}`,
    );
    expectNothingStarted(mock, sessionModule);
    // The popup has approved copy for it.
    expect(
      preStartIssue(
        snapshots(mock).at(-1).lastError,
        mock.chrome.i18n.getMessage,
      ),
    ).toBe(mock.chrome.i18n.getMessage("prestart_origin_not_authorized"));
  });

  it("either order on a restarted worker: grant first, then the popup's registration — the registration does not ride the revoked grant", async () => {
    const { mock, sessionModule } = await load({ tab: withSourceTab() });
    route(mock);
    await flush();
    const ack = await mock.dispatchGrantFirst({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
      nonce: "grant-first",
    });
    expect(ack).toEqual({ ok: true }); // registered; waits for its OWN grant
    await flush(20);
    expectNothingStarted(mock, sessionModule);
    expect(
      preStartIssue(
        snapshots(mock).at(-1).lastError,
        mock.chrome.i18n.getMessage,
      ),
    ).toBe(mock.chrome.i18n.getMessage("prestart_origin_not_authorized"));
  });

  it("the Start tab closed while no worker was running (no onRemoved seen): the grant is revoked at authorization and never becomes the authorized origin", async () => {
    const { mock, sessionModule } = await load({ tab: withSourceTab() });
    route(mock);
    await register(mock, "closed-unseen");
    // Gone in Chrome, but this worker never received tabs.onRemoved.
    mock.closeTab(TAB_ID, { notify: false });
    mock.grantArrives(ORIGIN);
    await waitUntil(lastErrorIs(mock, "source_tab_closed"));
    expect(snapshots(mock).at(-1).lastError).toBe(
      `source_tab_closed: ${ORIGIN}`,
    );
    await waitUntil(() => !mock.grants.has(GRANT));
    expectNothingStarted(mock, sessionModule);
  });

  it("pin: the Start tab left its origin while no worker was running: refused as source_tab_navigated, grant revoked (passes on 8608a0ff too)", async () => {
    const tab = withSourceTab();
    const { mock, sessionModule } = await load({ tab });
    route(mock);
    await register(mock, "navigated-unseen");
    tab.url = `${OTHER}/landing`; // no onUpdated delivered
    mock.grantArrives(ORIGIN);
    await waitUntil(lastErrorIs(mock, "source_tab_navigated"));
    expect(snapshots(mock).at(-1).lastError).toBe(
      `source_tab_navigated: ${ORIGIN}`,
    );
    await waitUntil(() => !mock.grants.has(GRANT));
    expectNothingStarted(mock, sessionModule);
  });

  it("control: registration then grant, tab live — the run still starts and settles", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock);
    await register(mock, "live");
    mock.grantArrives(ORIGIN);
    expect(await settle(mock)).toBe("ingest_succeeded");
    await flush();
    expect(mock.grants.has(GRANT)).toBe(false);
  });
});

describe("S1-A2 — a lost or refused /complete reply never becomes a local terminal", () => {
  it.each([
    ["lost", "network error"],
    ["timeout", "deadline"],
    ["refuse", "503"],
  ])(
    "/complete %s (%s), server says success → the server's success is shown, exactly one /complete, one status read",
    async (complete) => {
      const { mock } = await load({ tab: withSourceTab() });
      const { completes, statusReads } = route(mock, {
        complete,
        serverStatus: () => ({ status: "success", counts: [["clients", 1]] }),
      });
      await start(mock);
      expect(await settle(mock)).toBe("ingest_succeeded");
      const last = snapshots(mock).at(-1);
      expect(last.serverTerminal).toBe("success");
      expect(last.lastError).toBeNull();
      expect(statuses(mock)).not.toContain("ingest_failed");
      expect(completes.map((c) => c.terminal_status)).toEqual(["success"]);
      expect(statusReads).toHaveLength(1);
    },
  );

  it("/complete lost, server says partial → ingest_partial with the server's word", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock, {
      complete: "lost",
      serverStatus: () => ({ status: "partial", counts: [["clients", 1]] }),
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_partial");
    expect(snapshots(mock).at(-1).serverTerminal).toBe("partial");
    expect(statuses(mock)).not.toContain("ingest_failed");
  });

  it("/complete lost, server says failed → the server's failed is shown (it is the server's word, not ours)", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    const { completes } = route(mock, {
      complete: "lost",
      serverStatus: () => ({ status: "failed" }),
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_failed");
    expect(snapshots(mock).at(-1).serverTerminal).toBe("failed");
    expect(completes).toHaveLength(1);
  });

  it.each(["lost", "timeout", "refuse"])(
    "/complete %s, server still running → ingest_unconfirmed (never failed), serverStatus running, no second terminal",
    async (complete) => {
      const { mock } = await load({ tab: withSourceTab() });
      const { completes, statusReads } = route(mock, {
        complete,
        serverStatus: () => ({ status: "running" }),
      });
      await start(mock);
      expect(await settle(mock)).toBe("ingest_unconfirmed");
      const last = snapshots(mock).at(-1);
      expect(last.serverStatus).toBe("running");
      expect(last.serverTerminal).toBeUndefined();
      expect(last.lastError).toMatch(/^complete_unconfirmed: complete/);
      expect(statuses(mock)).not.toContain("ingest_failed");
      expect(statuses(mock)).not.toContain("ingest_succeeded");
      expect(completes.map((c) => c.terminal_status)).toEqual(["success"]);
      expect(statusReads).toHaveLength(1);
      expect(mock.notifications).toHaveLength(0);
    },
  );

  it("/complete lost and the server unreachable → ingest_unconfirmed with serverStatus unavailable, never failed", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    const { completes } = route(mock, {
      complete: "lost",
      serverStatus: () => "unreachable",
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_unconfirmed");
    const last = snapshots(mock).at(-1);
    expect(last.serverStatus).toBe("unavailable");
    expect(last.completeAttempt).toBe("complete_network_error");
    expect(statuses(mock)).not.toContain("ingest_failed");
    expect(completes).toHaveLength(1);
  });

  it("/complete timed out and the server has no record yet (404) → ingest_unconfirmed with serverStatus not_yet_known", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock, { complete: "timeout", serverStatus: () => null });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_unconfirmed");
    const last = snapshots(mock).at(-1);
    expect(last.serverStatus).toBe("not_yet_known");
    expect(last.completeAttempt).toBe("complete_timeout");
    expect(last.lastError).toBe("complete_unconfirmed: complete_timeout");
    expect(statuses(mock)).not.toContain("ingest_failed");
  });

  it("an engine-reported failure whose /complete(failed) reply is lost: the local reason is kept, the state is unconfirmed until the server says failed", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    const { completes } = route(mock, {
      sourceStatus: 404,
      complete: "lost",
      serverStatus: () => ({ status: "running" }),
    });
    await start(mock);
    expect(await settle(mock, 20000)).toBe("ingest_unconfirmed");
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toBe(
      "complete_unconfirmed: import failed — source responded 404",
    );
    expect(last.serverStatus).toBe("running");
    expect(statuses(mock)).not.toContain("ingest_failed");
    expect(completes.map((c) => c.terminal_status)).toEqual(["failed"]);
  }, 25000);

  it("a run ended by its tab closing, /complete(failed) lost, server committed failed → the server's failed with the honest local reason", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    const { completes } = route(mock, {
      complete: "lost",
      serverStatus: () => ({ status: "failed" }),
      onClients: async () => {
        mock.closeTab(TAB_ID);
        await flush(2);
      },
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_failed");
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toBe(`source_tab_closed: ${ORIGIN}`);
    expect(last.serverTerminal).toBe("failed");
    expect(completes.map((c) => c.terminal_status)).toEqual(["failed"]);
  });

  it("the rejected-/complete-with-revocation case of R35-c7A-02 is unconfirmed, not failed", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    const { completes, statusReads } = route(mock, {
      complete: "refuse",
      serverStatus: () => ({ status: "running" }),
      onClients: async () => {},
    });
    // Revoke while /complete is in flight.
    // @ts-expect-error -- vi.fn on global.fetch
    const inner = global.fetch.getMockImplementation();
    // @ts-expect-error -- vi.fn on global.fetch
    global.fetch.mockImplementation(async (url, init) => {
      if (url === COMPLETE_URL) {
        await mock.chrome.permissions.remove({ origins: [GRANT] });
        await flush(2);
      }
      return inner(url, init);
    });
    await start(mock);
    expect(await settle(mock)).toBe("ingest_unconfirmed");
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toBe(
      `complete_unconfirmed: origin_revoked: ${ORIGIN}`,
    );
    expect(last.serverStatus).toBe("running");
    expect(statuses(mock)).not.toContain("ingest_failed");
    expect(completes.map((c) => c.terminal_status)).toEqual(["success"]);
    expect(statusReads).toHaveLength(1);
  });

  it("pin: worker restart while /complete was in flight — the rehydrated run reads as needing a check, never as failed; Check status asks the server", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    const intentId = "imp-1790000000000";
    mock.localMap.set(SNAPSHOT_KEY, {
      kind: "status_snapshot",
      intent: { intentId, platform: "truecoach", status: "ingest_started" },
      progress: [{ entityType: "clients", sent: 1 }],
      staging: { clients: { received: 1, inserted: 1, deduped: 0 } },
      lastError: null,
    });
    const { statusReads } = route(mock, {
      serverStatus: () => ({ status: "success", counts: [["clients", 1]] }),
    });
    const snapshot = await mock.dispatchRaw({ kind: "request_status" });
    expect(snapshot.intent.status).toBe("ingest_started");
    expect(snapshot.workerActive).toBe(false);
    const view = outcomeView(snapshot, mock.chrome.i18n.getMessage);
    expect(view.title).toBe("Transfer status needs checking");
    expect(view.summary.toLowerCase()).not.toContain("failed");
    const server = await mock.dispatchRaw({ kind: "request_server_status" });
    expect(server).toMatchObject({
      kind: "server_status",
      state: "known",
      intentId,
      status: "success",
      settled: true,
    });
    expect(statusReads).toEqual([intentId]);
  });
});

describe("S1-A2 — the popup renders an unconfirmed terminal as neither failure nor success", () => {
  const message = makeBgMock().chrome.i18n.getMessage;
  const base = {
    kind: "status_snapshot",
    intent: {
      intentId: "imp-1",
      platform: "truecoach",
      status: "ingest_unconfirmed",
    },
    progress: [],
    staging: { clients: { received: 3, inserted: 3, deduped: 0 } },
    lastError: "complete_unconfirmed: complete_timeout",
  };

  it("server still running: title says not confirmed, the issue names TGP's running record, guidance points to Check status", () => {
    const view = outcomeView({ ...base, serverStatus: "running" }, message);
    expect(view.title).toBe("Final status not confirmed by TGP yet");
    expect(view.issue).toContain("still records this transfer as running");
    expect(view.guidance).toContain("Check status");
    expect(view.guidance).toContain("neither a failure nor a success");
    expect(view.summary).not.toContain("needs attention");
    expect(view.summary.toLowerCase()).not.toMatch(/\bfailed\b/);
    expect(view.lines[0].receipt).toContain("3 confirmed received");
  });

  it.each(["unavailable", "not_yet_known", undefined])(
    "server %s: the final status is stated as unconfirmed, receipts are kept",
    (serverStatus) => {
      const view = outcomeView({ ...base, serverStatus }, message);
      expect(view.title).toBe("Final status not confirmed by TGP yet");
      expect(view.issue).toContain("final status could not be confirmed");
      expect(view.summary).not.toContain("needs attention");
      expect(view.summary.toLowerCase()).not.toMatch(/\bfailed\b/);
    },
  );

  it("a local source-auth reason survives the unconfirmed prefix", () => {
    const view = outcomeView(
      {
        ...base,
        lastError:
          "complete_unconfirmed: source sign-in required — open your source platform and try again",
      },
      message,
    );
    expect(view.title).toBe("Final status not confirmed by TGP yet");
    expect(view.issue).toContain("source sign-in expired");
  });
});
