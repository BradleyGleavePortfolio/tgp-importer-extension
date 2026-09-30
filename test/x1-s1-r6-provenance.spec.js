import { describe, it, expect, vi } from "vitest";
import {
  makeBgMock,
  installChrome,
  acceptedIngest,
} from "./helpers/background-mock.js";
import { fakePageStore, realSourceTab } from "./helpers/source-tab.js";
import { wireStartImport, requestStartImport } from "../popup/popup.js";
import { outcomeView, preStartIssue } from "../popup/outcome.js";

// PR #35 round 6: closures for the S1 audit of 5804b506. The behavioural
// tests here FAIL on 5804b506 unless marked as a pin, where
//   S1-A5-01  Chrome's permissions.onAdded names only the ORIGIN. A Start
//             (A) whose tab closed, left the origin, expired or was refused
//             left its Chrome prompt open with no deadline; a later Start
//             (B) on ANOTHER live tab at the same origin replaced A's mark,
//             and A's late acceptance was claimed by B: B's tab was live, so
//             B was authorized and ran on a grant B never received.
//             Closure: A stays OUTSTANDING for its origin until its answer
//             arrives (its grant event, or its popup's own report by nonce);
//             while it is, no Start for that origin is registered
//             (`start_prompt_outstanding`, so the popup never opens a second
//             prompt for it), and a grant for the origin is A's answer:
//             revoked on arrival, nothing starts.
//   S1-A5-02  An unbound grant's removal that could not be VERIFIED (remove
//             rejected, or contains() could not answer) was discarded: the
//             host permission stayed held while Start stayed open.
//             Closure: the origin is recorded as grant debt; Start is refused
//             `cleanup_pending`, each refusal retries the removal, and Start
//             reopens only once Chrome verifies the grant gone.
//   C1        A server-settled `failed` shown with a `complete*` reason read
//             as "final status could not be confirmed" beside TGP's own
//             final status. The issue line now states that TGP settled it.

vi.setConfig({ testTimeout: 30000 });

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
const OTHER_TAB = 7;
// Three dot-separated segments (what the collector treats as a token shape),
// deliberately NOT JWT-encoded so no scanner exception is needed for it.
const SRC_TOKEN = "synthetic-header.synthetic-payload.not-a-signature";
const EXT_ID = "test-extension-id";
const GRANT = `${ORIGIN}/*`;
const OTHER_GRANT = `${OTHER}/*`;

function withSourceTab(opts = {}) {
  const stores = [
    fakePageStore(),
    fakePageStore([["truecoach.jwt", SRC_TOKEN]]),
  ];
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

// A one-client source, TGP ingest/progress/complete all acknowledged, the
// server's status read answering 404. `onClients` runs before page 1 replies.
function route(mock, { onClients = async () => {} } = {}) {
  // @ts-expect-error -- vi.fn on global.fetch
  global.fetch.mockImplementation(async (url, init) => {
    if (String(url).startsWith(STATUS_URL)) return { ok: false, status: 404 };
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
    if (url === COMPLETE_URL) return { ok: true, status: 200 };
    throw new Error(`unrouted fetch ${url}`);
  });
}

function register(mock, nonce, tabId = TAB_ID, url = TAB_URL) {
  return mock.dispatchRaw({ kind: "start_import", url, tabId, nonce });
}

const OUTSTANDING = { ok: false, error: "start_prompt_outstanding" };
const CLEANUP = { ok: false, error: "cleanup_pending" };

// Nothing may have started: no authorized origin, no collector injected, no
// source page read, no run snapshot, and Chrome holds no grant for the origin.
function expectNothingStarted(mock, sessionModule, grant = GRANT) {
  expect(sessionModule.getAuthorizedOrigin()).toBeNull();
  expect(mock.scripting.executed).toEqual([]);
  expect(sourceFetches()).toHaveLength(0);
  expect(snapshots(mock).some((s) => s.intent !== null)).toBe(false);
  expect(mock.grants.has(grant)).toBe(false);
}

describe("S1-A5-01 — a late grant from a closed, navigated or expired Start never authorizes a newer same-origin Start", () => {
  it("reproducer: A's tab closed, B registers on another live tab, A's prompt is accepted first → B was never registered, A's grant is revoked, nothing runs", async () => {
    const { mock, sessionModule } = await load({ tab: withSourceTab() });
    route(mock);
    expect(await register(mock, "first")).toEqual({ ok: true });
    mock.closeTab(TAB_ID);
    await waitUntil(lastErrorIs(mock, "source_tab_closed"));
    // B: a different, LIVE tab at the same origin. Its popup would prompt
    // next, and Chrome could not tell that prompt's answer from A's.
    expect(
      await register(mock, "second", OTHER_TAB, `${ORIGIN}/other`),
    ).toEqual(OUTSTANDING);
    // The coach answers A's still-open prompt (B's own prompt never opened).
    const removalsBefore = mock.permissionRemovals.length;
    mock.grantArrives(ORIGIN);
    await waitUntil(() => !mock.grants.has(GRANT));
    expect(mock.grants.has(GRANT)).toBe(false);
    expect(mock.permissionRemovals.length).toBeGreaterThan(removalsBefore);
    expect(snapshots(mock).at(-1).lastError).toBe(
      `source_tab_closed: ${ORIGIN}`,
    );
    await flush(10);
    expectNothingStarted(mock, sessionModule);
    // A's answer has arrived: a fresh Start for the origin is admitted again
    // and runs on ITS OWN grant, bound to ITS tab.
    expect(await register(mock, "third", OTHER_TAB, `${ORIGIN}/other`)).toEqual(
      { ok: true },
    );
    mock.grantArrives(ORIGIN);
    expect(await settle(mock)).toBe("ingest_succeeded");
    expect(mock.scripting.executed).toEqual([
      { target: { tabId: OTHER_TAB }, files: ["content/main.js"] },
    ]);
    await flush();
    expect(mock.grants.has(GRANT)).toBe(false);
  });

  it("parity with the standalone late-grant probe: authorizedOrigin stays null and the grant is not held after A-closed/B-registered/A-accepted", async () => {
    const { mock, sessionModule } = await load({ tab: withSourceTab() });
    global.fetch = vi.fn(() => new Promise(() => {}));
    await register(mock, "first");
    mock.closeTab(TAB_ID);
    await flush(2);
    const second = await register(mock, "second", OTHER_TAB, TAB_URL);
    mock.grantArrives(ORIGIN);
    await flush(10);
    expect(second.ok).toBe(false);
    expect(sessionModule.getAuthorizedOrigin()).toBeNull();
    expect(mock.grants.has(GRANT)).toBe(false);
    expect(snapshots(mock).at(-1).intent ?? null).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("A's tab left the origin: B is refused; A's late grant is revoked as source_tab_navigated and nothing runs", async () => {
    const tab = withSourceTab();
    const { mock, sessionModule } = await load({ tab });
    route(mock);
    await register(mock, "navigated");
    mock.navigateTab(TAB_ID, `${OTHER}/landing`);
    await waitUntil(lastErrorIs(mock, "source_tab_navigated"));
    tab.url = TAB_URL; // tab 7 is live on the origin
    expect(await register(mock, "second", OTHER_TAB, TAB_URL)).toEqual(
      OUTSTANDING,
    );
    mock.grantArrives(ORIGIN);
    await waitUntil(() => !mock.grants.has(GRANT));
    expect(snapshots(mock).at(-1).lastError).toBe(
      `source_tab_navigated: ${ORIGIN}`,
    );
    await flush(10);
    expectNothingStarted(mock, sessionModule);
  });

  it("A expired with its prompt open: B is refused until A's answer arrives; that answer is revoked as start_expired", async () => {
    vi.useFakeTimers();
    try {
      const { mock, sessionModule } = await load({ tab: withSourceTab() });
      route(mock);
      await register(mock, "slow");
      await vi.advanceTimersByTimeAsync(61_000);
      expect(snapshots(mock).at(-1).lastError).toBe(`start_expired: ${ORIGIN}`);
      expect(await register(mock, "second", OTHER_TAB, TAB_URL)).toEqual(
        OUTSTANDING,
      );
      // Minutes later the coach accepts A's prompt.
      await vi.advanceTimersByTimeAsync(180_000);
      mock.grantArrives(ORIGIN);
      await vi.advanceTimersByTimeAsync(10);
      expect(mock.grants.has(GRANT)).toBe(false);
      expect(snapshots(mock).at(-1).lastError).toBe(`start_expired: ${ORIGIN}`);
      expectNothingStarted(mock, sessionModule);
      // Now B may ask for its own grant.
      expect(await register(mock, "third", OTHER_TAB, TAB_URL)).toEqual({
        ok: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second Start on the same origin while A's prompt is still open is refused and leaves A intact: A's grant starts A's run on A's tab", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock);
    expect(await register(mock, "a")).toEqual({ ok: true });
    // The prompt closed the popup; the coach reopens it and presses Start
    // again (same tab), or presses Start on another tab of the same site.
    expect(await register(mock, "again", TAB_ID)).toEqual(OUTSTANDING);
    expect(await register(mock, "other", OTHER_TAB, TAB_URL)).toEqual(
      OUTSTANDING,
    );
    // No refusal revoked or replaced A's registration.
    expect(mock.permissionRemovals).toEqual([]);
    mock.grantArrives(ORIGIN);
    expect(await settle(mock)).toBe("ingest_succeeded");
    expect(mock.scripting.executed).toEqual([
      { target: { tabId: TAB_ID }, files: ["content/main.js"] },
    ]);
  });

  it("A superseded by a Start for ANOTHER origin stays outstanding for its own origin: a Start for it is refused, and A's late grant is revoked as start_superseded without touching the other registration", async () => {
    const { mock, sessionModule } = await load({ tab: withSourceTab() });
    route(mock);
    await register(mock, "a");
    expect(await register(mock, "c", OTHER_TAB, `${OTHER}/page`)).toEqual({
      ok: true,
    });
    await waitUntil(lastErrorIs(mock, "start_superseded"));
    expect(await register(mock, "b", 9, TAB_URL)).toEqual(OUTSTANDING);
    mock.grantArrives(ORIGIN);
    await waitUntil(() => !mock.grants.has(GRANT));
    expect(snapshots(mock).at(-1).lastError).toBe(
      `start_superseded: ${ORIGIN}`,
    );
    await flush(10);
    expectNothingStarted(mock, sessionModule);
    // C's registration for the other origin is still pending (not consumed,
    // not cancelled): a late popup cancel with C's nonce still finds it.
    expect(
      await mock.dispatchRaw({ kind: "start_unavailable", nonce: "c" }),
    ).toEqual({ ok: true });
    expect(await register(mock, "b2", 9, TAB_URL)).toEqual({ ok: true });
  });

  it("A's popup reports Chrome's answer (declined) by nonce: A is resolved and B may register and run on its own grant", async () => {
    const { mock, sessionModule } = await load({ tab: withSourceTab() });
    route(mock);
    await register(mock, "a");
    mock.closeTab(TAB_ID);
    await waitUntil(lastErrorIs(mock, "source_tab_closed"));
    expect(await register(mock, "b", OTHER_TAB, TAB_URL)).toEqual(OUTSTANDING);
    // A stranger's nonce resolves nothing.
    expect(
      await mock.dispatchRaw({ kind: "start_unavailable", nonce: "zzz" }),
    ).toEqual({ ok: false, error: "no_pending_start" });
    expect(await register(mock, "b", OTHER_TAB, TAB_URL)).toEqual(OUTSTANDING);
    // A's own popup (still alive) reports the coach declined A's prompt.
    expect(
      await mock.dispatchRaw({ kind: "start_unavailable", nonce: "a" }),
    ).toEqual({ ok: true });
    expectNothingStarted(mock, sessionModule);
    expect(await register(mock, "b", OTHER_TAB, TAB_URL)).toEqual({
      ok: true,
    });
    mock.grantArrives(ORIGIN);
    expect(await settle(mock)).toBe("ingest_succeeded");
    expect(mock.scripting.executed[0].target).toEqual({ tabId: OTHER_TAB });
  });

  it("A's popup reports Chrome answered true (a pre-held grant, no prompt) by nonce after A was refused: A is resolved", async () => {
    const { mock } = await load({ tab: withSourceTab(), held: [GRANT] });
    route(mock);
    await flush(); // startup sweep removes the leftover
    mock.grants.add(GRANT); // ...and Chrome holds one again before Start
    await register(mock, "a");
    await waitUntil(lastErrorIs(mock, "start_not_authorized"));
    expect(mock.grants.has(GRANT)).toBe(false);
    expect(await register(mock, "b", OTHER_TAB, TAB_URL)).toEqual(OUTSTANDING);
    expect(
      await mock.dispatchRaw({ kind: "start_granted", nonce: "a" }),
    ).toEqual({ ok: true });
    expect(await register(mock, "b", OTHER_TAB, TAB_URL)).toEqual({
      ok: true,
    });
  });

  it("a Start refused while an earlier same-origin Start is pending is not a revoke: the popup gets its own approved copy, no Chrome call is made", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock);
    await register(mock, "a");
    await register(mock, "b", OTHER_TAB, TAB_URL);
    expect(mock.permissionRemovals).toEqual([]);
    expect(mock.permissionRequests).toEqual([]);
    const message = mock.chrome.i18n.getMessage;
    expect(preStartIssue("start_prompt_outstanding", message)).toBe(
      message("prestart_prompt_outstanding"),
    );
    expect(preStartIssue("start_prompt_outstanding", message)).not.toBe(
      message("prestart_unknown"),
    );
    expect(preStartIssue(`start_grant_ambiguous: ${ORIGIN}`, message)).toBe(
      message("prestart_origin_not_authorized"),
    );
  });

  it("popup: the worker's start_prompt_outstanding refusal never prompts Chrome and shows the approved line", async () => {
    const btn = {
      disabled: false,
      handlers: {},
      addEventListener(type, fn) {
        this.handlers[type] = fn;
      },
    };
    const errorBox = { hidden: true, textContent: "" };
    const doc = { getElementById: (id) => (id === "error" ? errorBox : btn) };
    const runtime = { sendMessage: vi.fn(async () => OUTSTANDING) };
    const tabs = { query: vi.fn(async () => [{ id: 7, url: TAB_URL }]) };
    const permissions = { request: vi.fn(async () => true) };
    const getMessage = makeBgMock().chrome.i18n.getMessage;
    expect(await requestStartImport(runtime, tabs, permissions)).toEqual(
      OUTSTANDING,
    );
    expect(permissions.request).not.toHaveBeenCalled();
    wireStartImport(runtime, tabs, doc, getMessage, permissions);
    btn.handlers.click();
    await flush(3);
    expect(errorBox.hidden).toBe(false);
    expect(errorBox.textContent).toBe(
      getMessage("prestart_prompt_outstanding"),
    );
    expect(errorBox.textContent).not.toContain("start_");
    expect(errorBox.textContent).not.toContain("https://");
    expect(permissions.request).not.toHaveBeenCalled();
  });
});

describe("S1-A5-02 — an unbound grant whose removal is not verified closes the Start gate until it is", () => {
  async function lateGrantWithTabClosed(mock) {
    await register(mock, "lost");
    mock.closeTab(TAB_ID);
    await waitUntil(lastErrorIs(mock, "source_tab_closed"));
    mock.grantArrives(ORIGIN);
    await flush(10);
  }

  it.each([
    ["remove() rejects", { failRevoke: true }, "failRevoke"],
    [
      "remove() resolves but Chrome keeps the grant",
      { ignoreRemove: true },
      "ignoreRemove",
    ],
    [
      "contains() cannot verify after remove()",
      { failContains: true },
      "failContains",
    ],
  ])(
    "%s: the late grant is recorded as debt, Start is refused cleanup_pending and retries, and reopens only when Chrome verifies the grant gone",
    async (_label, knobs, knob) => {
      const { mock, sessionModule } = await load({ tab: withSourceTab() });
      route(mock);
      await flush(); // the startup sweep verified a clean worker first
      Object.assign(mock.knobs, knobs);
      await lateGrantWithTabClosed(mock);
      const stillHeld = knob !== "failContains";
      expect(mock.grants.has(GRANT)).toBe(stillHeld);
      expect(mock.permissionRemovals.length).toBeGreaterThan(0);
      expect(sessionModule.getAuthorizedOrigin()).toBeNull();
      // The gate is closed for EVERY origin, and each refusal retries.
      const removalsBefore = mock.permissionRemovals.length;
      expect(await register(mock, "again", OTHER_TAB, TAB_URL)).toEqual(
        CLEANUP,
      );
      expect(await register(mock, "elsewhere", 9, `${OTHER}/x`)).toEqual(
        CLEANUP,
      );
      await flush(10);
      expect(mock.permissionRemovals.length).toBeGreaterThan(removalsBefore);
      expect(mock.grants.has(GRANT)).toBe(stillHeld);
      // A grant arriving meanwhile is refused for the same reason.
      mock.grantArrives(OTHER);
      await waitUntil(lastErrorIs(mock, "start_refused_cleanup"));
      expect(snapshots(mock).at(-1).lastError).toBe(
        `start_refused_cleanup: ${OTHER}`,
      );
      // Chrome recovers. The next Start still finds the debt (it is what
      // triggers the retry), and the retry verifies the removal...
      mock.knobs[knob] = false;
      expect(await register(mock, "retry", OTHER_TAB, TAB_URL)).toEqual(
        CLEANUP,
      );
      await waitUntil(() => !mock.grants.has(GRANT));
      await flush(10);
      expect(mock.grants.has(GRANT)).toBe(false);
      expect(mock.grants.has(OTHER_GRANT)).toBe(false);
      // ...so Start is admitted and a run proceeds on its own grant.
      expect(await register(mock, "fresh", OTHER_TAB, TAB_URL)).toEqual({
        ok: true,
      });
      expectNothingStarted(mock, sessionModule);
      mock.grantArrives(ORIGIN);
      expect(await settle(mock)).toBe("ingest_succeeded");
    },
  );

  it("a grant with no Start behind it on a restarted worker whose removal fails is debt too (start_not_registered)", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock);
    await flush();
    mock.knobs.failRevoke = true;
    mock.grantArrives(ORIGIN);
    await waitUntil(lastErrorIs(mock, "start_not_registered"));
    await flush(4);
    expect(mock.grants.has(GRANT)).toBe(true);
    expect(await register(mock, "s", TAB_ID)).toEqual(CLEANUP);
    mock.knobs.failRevoke = false;
    expect(await register(mock, "s", TAB_ID)).toEqual(CLEANUP);
    await waitUntil(() => !mock.grants.has(GRANT));
    await flush(10); // the retry's verification read completes
    expect(await register(mock, "s", TAB_ID)).toEqual({ ok: true });
  });

  it("debt for another origin during a live run never touches the run, and settling the run does not forgive the debt", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((r) => {
      release = () => r(undefined);
    });
    route(mock, { onClients: () => gate });
    await register(mock, "run");
    mock.grantArrives(ORIGIN);
    await waitUntil(() => sourceFetches().length > 0);
    // A stray grant for another origin whose removal fails, mid-run.
    mock.knobs.failRevoke = true;
    mock.grantArrives(OTHER);
    await waitUntil(lastErrorIs(mock, "start_refused_busy"));
    await flush(4);
    expect(mock.grants.has(OTHER_GRANT)).toBe(true);
    expect(mock.grants.has(GRANT)).toBe(true); // the run's own grant is intact
    mock.knobs.failRevoke = false;
    release();
    expect(await settle(mock)).toBe("ingest_succeeded");
    await flush();
    expect(mock.grants.has(GRANT)).toBe(false);
    // The run settled clean, yet the other origin's debt still gates Start.
    expect(mock.grants.has(OTHER_GRANT)).toBe(true);
    expect(await register(mock, "next", TAB_ID)).toEqual(CLEANUP);
    await waitUntil(() => !mock.grants.has(OTHER_GRANT));
    await flush(10); // the retry's verification read completes
    expect(await register(mock, "next", TAB_ID)).toEqual({ ok: true });
  });

  it("pin: a verified removal records no debt — the next Start is admitted at once (passes on 5804b506 too)", async () => {
    const { mock } = await load({ tab: withSourceTab() });
    route(mock);
    await lateGrantWithTabClosed(mock);
    expect(mock.grants.has(GRANT)).toBe(false);
    expect(await register(mock, "next", OTHER_TAB, TAB_URL)).toEqual({
      ok: true,
    });
  });
});

describe("C1 — a server-settled terminal is never shown beside 'could not be confirmed'", () => {
  const message = makeBgMock().chrome.i18n.getMessage;
  const base = {
    kind: "status_snapshot",
    intent: {
      intentId: "imp-1",
      platform: "truecoach",
      status: "ingest_failed",
    },
    progress: [],
    staging: { clients: { received: 3, inserted: 3, deduped: 0 } },
    lastError: "complete_network_error",
  };

  it("server failed with a lost /complete reply: the issue line says TGP recorded the final status", () => {
    const view = outcomeView({ ...base, serverTerminal: "failed" }, message);
    expect(view.title).toBe("Transfer needs attention");
    expect(view.issue).toBe(message("outcome_server_settled"));
    expect(view.summary).not.toContain("could not be confirmed");
    expect(view.lines[0].receipt).toContain("3 confirmed received");
  });

  it("without a server terminal the settlement line is unchanged", () => {
    const view = outcomeView(base, message);
    expect(view.issue).toBe(message("outcome_settlement_failed"));
  });

  it("an unconfirmed run with the server still running keeps its own line", () => {
    const view = outcomeView(
      {
        ...base,
        intent: { ...base.intent, status: "ingest_unconfirmed" },
        lastError: "complete_unconfirmed: complete_timeout",
        serverStatus: "running",
      },
      message,
    );
    expect(view.issue).toBe(message("outcome_unconfirmed_server_running"));
  });
});
