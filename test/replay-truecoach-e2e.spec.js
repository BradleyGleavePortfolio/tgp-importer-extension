import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";
import { fakePageStore, realSourceTab } from "./helpers/source-tab.js";

// End-to-end proof that the GENERIC, site-agnostic replay path reproduces the
// verified TrueCoach request contract and completes one real, fixture-shaped run
// — driven through the REAL background.js start_import router, the REAL declarative
// TrueCoach blueprint, and the REAL content-script token producer. Nothing here is
// TrueCoach-specific engine logic: the platform contract (Role/Accept headers, the
// clients -> notes fan-out) lives entirely in adapter DATA. This locks:
//   - the clients page from a REAL recorded fixture (2 clients, ids 7 & 8),
//   - exactly one notes fetch per client (autonomous fan-out over collected ids),
//   - the exact entity total ingested,
//   - a terminal ingest_succeeded with complete() called exactly once,
//   - every SOURCE request carrying the coach's bearer + the declared Role + Accept,
//   - every ingested entity preserving the LOCKED { sourceId, sourcePlatform,
//     capturedAt, payload } envelope,
//   - the source bearer NEVER leaking into a broadcast, storage, notification, tab
//     message, or ingest payload.
//
// Determinism: fake timers make the engine's 500ms pacing a virtual no-op (an
// advance-driver flushes each sleep) and the system clock is pinned, so capturedAt
// is reproducible and the run needs no wall-clock waiting.

const REFRESH_KEY = "tgp_refresh_token";
const REFRESH_URL = "https://api.tgp.coach/api/auth/extension/refresh";
const INGEST_URL = "https://api.tgp.coach/api/scout/ingest";
const COMPLETE_URL = "https://api.tgp.coach/api/scout/ingest/complete";
const SOURCE_ORIGIN = "https://app.truecoach.co";
const CLIENTS_PREFIX = "https://app.truecoach.co/proxy/api/clients?";
const TAB_URL = "https://app.truecoach.co/clients";
const TAB_ID = 42;
const EXT_ID = "test-extension-id";
// A JWT-shaped SOURCE bearer the REAL content-script producer reads from the
// coach's own page storage (three-segment base64url, per content/main.js).
const SRC_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb2FjaCJ9.s1g-nature_TOKEN";

// The clients page comes from the REAL recorded CDP fixture, not a hand-rolled
// stub — this ties the generic crawl to a payload shape TrueCoach actually emits.
const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./fixtures/cdp-traces/truecoach-clients.json", import.meta.url),
    ),
    "utf8",
  ),
);
const FIXTURE_CLIENTS = JSON.parse(FIXTURE.responseBody.body).clients;
const CLIENT_IDS = FIXTURE_CLIENTS.map((c) => c.id); // [7, 8]
// Deterministic, DISTINCT notes per client so the fan-out is provably per-parent
// (client 7 -> 2 notes, client 8 -> 1 note): total notes = 3.
const NOTES_BY_CLIENT = { 7: [{ id: 701 }, { id: 702 }], 8: [{ id: 801 }] };
const notesUrl = (id) => `${SOURCE_ORIGIN}/proxy/api/clients/${id}/notes`;

function withSourceTab() {
  const stores = [fakePageStore(), fakePageStore([["truecoach.jwt", SRC_JWT]])];
  return { url: TAB_URL, sendMessage: realSourceTab(EXT_ID, stores) };
}

async function load({ session, tab } = {}) {
  vi.resetModules();
  const mock = makeBgMock({ session, tab });
  installChrome(mock);
  global.fetch = vi.fn();
  await import("../background.js");
  return mock;
}

function snapshots(mock) {
  return mock.sent.filter((m) => m && m.kind === "status_snapshot");
}
function terminalStatus(mock) {
  const last = snapshots(mock).at(-1);
  const status = last && last.intent ? last.intent.status : null;
  return status === "ingest_succeeded" ||
    status === "ingest_failed" ||
    status === "ingest_partial"
    ? status
    : null;
}

// Drive the run under fake timers: flush microtasks, then release each virtual
// pacing sleep, until a terminal status is broadcast (or a bounded step cap trips,
// which would itself fail the terminal assertion rather than hang).
async function drive(mock, steps = 200) {
  for (let i = 0; i < steps; i += 1) {
    await vi.advanceTimersByTimeAsync(500);
    if (terminalStatus(mock) !== null) {
      return terminalStatus(mock);
    }
  }
  return terminalStatus(mock);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("replay TrueCoach e2e — generic engine reproduces the verified contract", () => {
  it("crawls the real clients fixture, fans out to notes, ingests, and succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    const mock = await load({
      session: new Map([[REFRESH_KEY, "seed-refresh"]]),
      tab: withSourceTab(),
    });

    const sourceReqs = []; // { url, headers } for every truecoach-origin request
    const notesFetched = []; // client id per notes request
    const ingestBodies = [];
    let completeCalls = 0;

    global.fetch.mockImplementation(async (url, init) => {
      if (url === REFRESH_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "TGP-ACCESS" }),
        };
      }
      if (new URL(url).origin === SOURCE_ORIGIN) {
        sourceReqs.push({ url, headers: init.headers });
      }
      if (url.startsWith(CLIENTS_PREFIX) && url.includes("page=1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ clients: FIXTURE_CLIENTS }),
        };
      }
      if (url.startsWith(CLIENTS_PREFIX) && url.includes("page=2")) {
        return { ok: true, status: 200, json: async () => ({ clients: [] }) };
      }
      for (const id of CLIENT_IDS) {
        if (url === notesUrl(id)) {
          notesFetched.push(id);
          return {
            ok: true,
            status: 200,
            json: async () => ({ notes: NOTES_BY_CLIENT[id] }),
          };
        }
      }
      if (url === INGEST_URL) {
        ingestBodies.push(JSON.parse(init.body));
        return { ok: true, status: 200 };
      }
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
    const terminal = await drive(mock);

    // Exact client count from the real fixture (not a synthetic stub).
    expect(CLIENT_IDS).toEqual([7, 8]);
    // Exactly one notes fetch per client, one per collected id — autonomous
    // fan-out, no duplicates, no missing parents.
    expect(notesFetched.sort()).toEqual([7, 8]);

    // Exact entity total: 2 clients + (2 + 1) notes = 5, and the per-type split
    // proves the fan-out distributed notes per parent.
    const byType = {};
    for (const body of ingestBodies) {
      byType[body.entity_type] =
        (byType[body.entity_type] ?? 0) + body.entities.length;
    }
    expect(byType.clients).toBe(2);
    expect(byType.notes).toBe(3);
    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    expect(total).toBe(5);

    // Terminal success, complete() exactly once.
    expect(terminal).toBe("ingest_succeeded");
    expect(completeCalls).toBe(1);

    // Every SOURCE request reproduced the verified contract: the coach's bearer
    // (added LAST by makeSourceFetch) PLUS the declared Role + Accept headers.
    expect(sourceReqs.length).toBe(4); // clients p1, clients p2, notes/7, notes/8
    for (const req of sourceReqs) {
      expect(req.headers.Authorization).toBe(`Bearer ${SRC_JWT}`);
      expect(req.headers.Role).toBe("Trainer");
      expect(req.headers.Accept).toBe("application/json, text/html");
    }

    // Every ingested entity preserves the LOCKED envelope, verbatim.
    const allEntities = ingestBodies.flatMap((b) => b.entities);
    expect(allEntities).toHaveLength(5);
    for (const e of allEntities) {
      expect(Object.keys(e).sort()).toEqual([
        "capturedAt",
        "payload",
        "sourceId",
        "sourcePlatform",
      ]);
      expect(e.sourcePlatform).toBe("truecoach");
      expect(typeof e.sourceId).toBe("string");
      expect(typeof e.capturedAt).toBe("string");
    }

    // The SOURCE bearer must never escape into any observable sink. It legitimately
    // rides the OUTBOUND source request headers (asserted above) but must appear
    // NOWHERE else: broadcasts, storage (session/local/sync), notifications, tab
    // messages, or ingest payloads.
    const sinks = JSON.stringify({
      sent: mock.sent,
      notifications: mock.notifications,
      tabMessages: mock.tabMessages,
      syncSet: mock.syncSet,
      session: [...mock.sessionMap.entries()],
      local: [...mock.localMap.entries()],
      ingest: ingestBodies,
    });
    expect(sinks).not.toContain(SRC_JWT);
  }, 20000);
});

describe("makeSourceFetch — the source bearer is applied LAST (spoof resistance)", () => {
  it("drops an adapter-supplied Authorization and forces the coach's bearer", async () => {
    vi.resetModules();
    installChrome(makeBgMock());
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push(init);
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const { makeSourceFetch } = await import("../background.js");
    const fetchJson = makeSourceFetch("REAL-COACH-TOKEN");
    await fetchJson(`${SOURCE_ORIGIN}/proxy/api/clients`, {
      method: "GET",
      // A hostile/auto-inferred blueprint tries BOTH spellings plus a benign header.
      headers: {
        Authorization: "Bearer SPOOF",
        authorization: "Bearer spoof2",
        Role: "Trainer",
      },
      signal: null,
      timeoutMs: 1000,
    });
    const sent = calls[0].headers;
    // The coach's bearer wins; NEITHER spoof spelling survives.
    expect(sent.Authorization).toBe("Bearer REAL-COACH-TOKEN");
    expect(sent.authorization).toBeUndefined();
    // Non-auth adapter headers pass through untouched.
    expect(sent.Role).toBe("Trainer");
  });

  it("sends NO Authorization when there is no source token, even if the adapter set one", async () => {
    vi.resetModules();
    installChrome(makeBgMock());
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push(init);
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const { makeSourceFetch } = await import("../background.js");
    const fetchJson = makeSourceFetch(""); // no live token
    await fetchJson(`${SOURCE_ORIGIN}/proxy/api/clients`, {
      method: "GET",
      headers: { Authorization: "Bearer SPOOF", Role: "Trainer" },
      signal: null,
      timeoutMs: 1000,
    });
    const sent = calls[0].headers;
    expect(sent.Authorization).toBeUndefined();
    expect(sent.Role).toBe("Trainer");
  });
});

describe("engine — effective headers compose blueprint + step (step overrides per key)", () => {
  it("passes {...blueprint, ...step} to fetchJson with step winning on shared keys", async () => {
    const { runReplay } = await import("../shared/replay/engine.js");
    const seen = [];
    const blueprint = {
      platform: "test",
      apiBase: "https://api.test/base",
      headers: { Accept: "blueprint-accept", "X-Base": "base-only" },
      steps: [
        {
          id: "s",
          entityType: "thing",
          template: "/things",
          headers: { Accept: "step-accept", "X-Step": "step-only" },
        },
      ],
    };
    await runReplay({
      blueprint,
      allowedOrigins: ["https://api.test"],
      fetchJson: async (url, init) => {
        seen.push(init.headers);
        return { things: [] };
      },
      emit: async () => {},
      now: () => 0,
      sleep: async () => {},
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      Accept: "step-accept", // step overrides blueprint on the shared key
      "X-Base": "base-only",
      "X-Step": "step-only",
    });
  });
});
