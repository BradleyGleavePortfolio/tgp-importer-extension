import { describe, it, expect, vi } from "vitest";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";
import { fakePageStore, realSourceTab } from "./helpers/source-tab.js";

// Adversarial, wiring-layer coverage of the start_import HARDENING findings
// (Fixer r1). Each block pins one audit fix end-to-end through the real router +
// orchestration in background.js, driving the ACTUAL content-script token
// producer where a bearer is involved:
//   - the source bearer never leaks to any observable surface,
//   - completeIngest never claims success on a non-2xx acknowledgement,
//   - a degraded walk surfaces a DISTINCT partial terminal state (not success),
//   - a TGP auth loss yields ONE friendly terminal state (no order-dependent
//     overwrite),
//   - the single-flight guard is SHARED across start_import and legacy
//     start_ingest (both directions + same-entrypoint).

const REFRESH_KEY = "tgp_refresh_token";
const REFRESH_URL = "https://api.tgp.coach/api/auth/extension/refresh";
const INGEST_URL = "https://api.tgp.coach/api/scout/ingest";
const COMPLETE_URL = "https://api.tgp.coach/api/scout/ingest/complete";
const CLIENTS_PREFIX = "https://app.truecoach.co/proxy/api/clients?";
const NOTES_URL = "https://app.truecoach.co/proxy/api/clients/c1/notes";
const TAB_URL = "https://app.truecoach.co/clients";
const TAB_ID = 42;
const EXT_ID = "test-extension-id";
const SRC_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb2FjaCJ9.s1g-nature_SECRET";

function seeded() {
  return new Map([[REFRESH_KEY, "seed-refresh"]]);
}
function withSourceTab() {
  const stores = [fakePageStore(), fakePageStore([["truecoach.jwt", SRC_JWT]])];
  return { url: TAB_URL, sendMessage: realSourceTab(EXT_ID, stores) };
}

async function load({ session, tab } = {}) {
  vi.resetModules();
  const mock = makeBgMock({ session, tab });
  installChrome(mock);
  global.fetch = vi.fn();
  const bg = await import("../background.js");
  return { mock, bg };
}

function snapshots(mock) {
  return mock.sent.filter((m) => m && m.kind === "status_snapshot");
}
function authRequired(mock) {
  return mock.sent.filter((m) => m && m.kind === "auth_required");
}
function statuses(mock) {
  return snapshots(mock).map((s) => (s.intent ? s.intent.status : null));
}
async function settle(mock, ms = 12000) {
  const start = Date.now();
  for (;;) {
    const last = snapshots(mock).at(-1);
    const status = last && last.intent ? last.intent.status : null;
    const terminal =
      status === "ingest_succeeded" ||
      status === "ingest_failed" ||
      status === "ingest_partial";
    if (terminal || authRequired(mock).length > 0 || Date.now() - start > ms) {
      return status;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("start_import — the source bearer never leaks to any surface", () => {
  it("keeps the token out of broadcasts, storage, notifications, and ingest payloads", async () => {
    const { mock } = await load({ session: seeded(), tab: withSourceTab() });
    const ingestBodies = [];
    global.fetch.mockImplementation(async (url, init) => {
      if (url === REFRESH_URL)
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "TGP-ACCESS" }),
        };
      if (url.startsWith(CLIENTS_PREFIX) && url.includes("page=1"))
        return {
          ok: true,
          status: 200,
          json: async () => ({ clients: [{ id: "c1" }] }),
        };
      if (url.startsWith(CLIENTS_PREFIX))
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      if (url === NOTES_URL)
        return {
          ok: true,
          status: 200,
          json: async () => ({ notes: [{ id: "n1" }] }),
        };
      if (url === INGEST_URL) {
        ingestBodies.push(init.body);
        return { ok: true, status: 200 };
      }
      if (url === COMPLETE_URL) return { ok: true, status: 200 };
      throw new Error(`unrouted fetch ${url}`);
    });

    const ack = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(ack).toEqual({ ok: true });
    expect(await settle(mock)).toBe("ingest_succeeded");

    // The crawl DID authenticate (proving the token was actually used), yet it
    // appears on no observable surface.
    const seenAnywhere = [
      JSON.stringify(mock.sent), // broadcasts / popup messages (telemetry)
      JSON.stringify([...mock.localMap.values()]), // on-disk storage
      JSON.stringify([...mock.sessionMap.values()]), // session storage
      JSON.stringify(mock.syncSet),
      JSON.stringify(mock.notifications),
      JSON.stringify(mock.tabMessages), // messages sent TO the content script
      ingestBodies.join("|"), // backend payload
    ].join("||");
    expect(seenAnywhere).not.toContain(SRC_JWT);
    // Sanity: the ingest payload never carried an Authorization field either.
    expect(ingestBodies.join("|")).not.toMatch(/[Aa]uthorization/);
  }, 15000);
});

describe("start_import — completeIngest must be acknowledged (non-2xx != success)", () => {
  it("reports ingest_failed and never broadcasts success when complete returns 500", async () => {
    const { mock } = await load({ session: seeded(), tab: withSourceTab() });
    global.fetch.mockImplementation(async (url) => {
      if (url === REFRESH_URL)
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "TGP-ACCESS" }),
        };
      if (url.startsWith(CLIENTS_PREFIX) && url.includes("page=1"))
        return {
          ok: true,
          status: 200,
          json: async () => ({ clients: [{ id: "c1" }] }),
        };
      if (url.startsWith(CLIENTS_PREFIX))
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      if (url === NOTES_URL)
        return {
          ok: true,
          status: 200,
          json: async () => ({ notes: [{ id: "n1" }] }),
        };
      if (url === INGEST_URL) return { ok: true, status: 200 };
      if (url === COMPLETE_URL) return { ok: false, status: 500 };
      throw new Error(`unrouted fetch ${url}`);
    });
    const ack = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(ack).toEqual({ ok: true });
    expect(await settle(mock)).toBe("ingest_failed");
    // The dishonest success must NEVER have been broadcast, even momentarily.
    expect(statuses(mock)).not.toContain("ingest_succeeded");
    expect(snapshots(mock).at(-1).lastError).toMatch(/complete 500/);
    // A failed finalisation raises no completion notification.
    expect(mock.notifications).toHaveLength(0);
  }, 15000);
});

describe("start_import — a degraded walk surfaces a DISTINCT partial state", () => {
  it("finalises but reports ingest_partial (not success) when a page is skipped", async () => {
    const { mock } = await load({ session: seeded(), tab: withSourceTab() });
    let completeCalls = 0;
    global.fetch.mockImplementation(async (url) => {
      if (url === REFRESH_URL)
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "TGP-ACCESS" }),
        };
      if (url.startsWith(CLIENTS_PREFIX) && url.includes("page=1"))
        return {
          ok: true,
          status: 200,
          json: async () => ({ clients: [{ id: "c1" }] }),
        };
      if (url.startsWith(CLIENTS_PREFIX))
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      // Per-client notes page persistently 500s -> retries exhaust -> the page
      // is SKIPPED (degraded) while the client roster still ingested.
      if (url === NOTES_URL) return { ok: false, status: 500 };
      if (url === INGEST_URL) return { ok: true, status: 200 };
      if (url === COMPLETE_URL) {
        completeCalls += 1;
        return { ok: true, status: 200 };
      }
      throw new Error(`unrouted fetch ${url}`);
    });
    const ack = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(ack).toEqual({ ok: true });
    expect(await settle(mock)).toBe("ingest_partial");
    // Partial is honest: it DID finalise (we ingested the roster) but says so
    // distinctly, never "succeeded".
    expect(completeCalls).toBe(1);
    expect(statuses(mock)).not.toContain("ingest_succeeded");
    const lastError = snapshots(mock).at(-1).lastError;
    expect(lastError).toMatch(/skipped/);
    expect(lastError).not.toMatch(/eyJ/); // no token fragment in the message
  }, 15000);
});

describe("start_import — one friendly terminal state on TGP auth loss", () => {
  it("keeps the 'session expired' state and does not overwrite it with a raw error", async () => {
    const { mock } = await load({ session: seeded(), tab: withSourceTab() });
    let refreshCalls = 0;
    global.fetch.mockImplementation(async (url) => {
      if (url === REFRESH_URL) {
        refreshCalls += 1;
        // First refresh mints the access token; the mid-crawl refresh (after
        // the ingest 401) fails -> refreshAccessToken() returns null.
        return refreshCalls === 1
          ? {
              ok: true,
              status: 200,
              json: async () => ({ access_token: "TGP-ACCESS" }),
            }
          : { ok: false, status: 401, json: async () => ({}) };
      }
      if (url.startsWith(CLIENTS_PREFIX) && url.includes("page=1"))
        return {
          ok: true,
          status: 200,
          json: async () => ({ clients: [{ id: "c1" }] }),
        };
      if (url.startsWith(CLIENTS_PREFIX))
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      if (url === INGEST_URL) return { ok: false, status: 401 }; // TGP session lost mid-crawl
      throw new Error(`unrouted fetch ${url}`);
    });
    const ack = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(ack).toEqual({ ok: true });
    await settle(mock);
    // Exactly one friendly terminal state wins; no raw "ingest ... 401" leaks
    // past it, and success was never claimed.
    expect(authRequired(mock)).toHaveLength(1);
    expect(snapshots(mock).at(-1).lastError).toBe(
      "session expired — please sign in again",
    );
    expect(statuses(mock)).not.toContain("ingest_succeeded");
    expect(
      snapshots(mock).some(
        (s) =>
          typeof s.lastError === "string" && /ingest .*401/.test(s.lastError),
      ),
    ).toBe(false);
    // A TGP auth loss DOES clear the TGP tokens (distinct from a source loss).
    expect(mock.sessionMap.has(REFRESH_KEY)).toBe(false);
  }, 15000);
});

describe("single-flight guard is SHARED across start_import and start_ingest", () => {
  it("rejects a start_ingest while a start_import is in flight", async () => {
    const { mock } = await load({ session: seeded() });
    global.fetch.mockImplementation(() => new Promise(() => {})); // hang the first run
    const a = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    const b = await mock.dispatch({ kind: "start_ingest", url: TAB_URL });
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: false, error: "import_in_progress" });
  });

  it("rejects a start_import while a start_ingest is in flight", async () => {
    const { mock } = await load({ session: seeded() });
    global.fetch.mockImplementation(() => new Promise(() => {}));
    const a = await mock.dispatch({ kind: "start_ingest", url: TAB_URL });
    const b = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: false, error: "import_in_progress" });
  });

  it("rejects a second start_ingest while the first is in flight", async () => {
    const { mock } = await load({ session: seeded() });
    global.fetch.mockImplementation(() => new Promise(() => {}));
    const a = await mock.dispatch({ kind: "start_ingest", url: TAB_URL });
    const b = await mock.dispatch({ kind: "start_ingest", url: TAB_URL });
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: false, error: "import_in_progress" });
  });
});
