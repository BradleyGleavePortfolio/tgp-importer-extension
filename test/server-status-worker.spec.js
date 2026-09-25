import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installChrome, makeBgMock } from "./helpers/background-mock.js";

// Worker half of Check status: `request_server_status` reads
// GET /api/scout/import/status for the worker's OWN recorded run, with the
// existing paired-session bearer. It must never change the snapshot, Start,
// tokens or run control, and never accept a caller-supplied run id.
const fixture = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "test/fixtures/import-status/import-status.fixture.json",
    ),
    "utf8",
  ),
);
const REFRESH_KEY = "tgp_refresh_token";
const SNAPSHOT_KEY = "tgp_status_snapshot";
const REFRESH_URL = "https://api.tgp.coach/api/auth/extension/refresh";
const INTENT = "imp-1790000000000";
const STATUS_URL = `https://api.tgp.coach/api/scout/import/status?intent_id=${INTENT}`;

const recorded = {
  kind: "status_snapshot",
  intent: { intentId: INTENT, platform: "truecoach", status: "ingest_partial" },
  progress: [{ entityType: "clients", sent: 7 }],
  staging: { clients: { received: 7, inserted: 7, deduped: 0 } },
  lastError: null,
};

let fetchMock = vi.fn();

/** @param {{ session?: boolean, snapshot?: object | null }} [options] */
async function load({ session = true, snapshot = recorded } = {}) {
  vi.resetModules();
  const mock = makeBgMock({
    session: session ? new Map([[REFRESH_KEY, "seed-refresh"]]) : new Map(),
  });
  installChrome(mock);
  fetchMock = vi.fn();
  global.fetch = fetchMock;
  await import("../background.js");
  if (snapshot) mock.localMap.set(SNAPSHOT_KEY, structuredClone(snapshot));
  return mock;
}

function answer(example) {
  return new Response(JSON.stringify(example.body), {
    status: example.http_status,
    headers: { "content-type": "application/json" },
  });
}

// Route refresh + status; `statuses` is consumed one reply per status call.
function route(statuses) {
  const calls = { refresh: 0, status: [] };
  fetchMock.mockImplementation(async (url, init) => {
    if (url === REFRESH_URL) {
      calls.refresh += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: `TGP-ACCESS-${calls.refresh}` }),
      };
    }
    if (typeof url === "string" && url.includes("/api/scout/import/status")) {
      calls.status.push({ url, init });
      const next = statuses.shift();
      if (next instanceof Error) throw next;
      return answer(next);
    }
    throw new Error(`unrouted fetch ${url}`);
  });
  return calls;
}

function sideEffects(mock) {
  return {
    snapshot: JSON.stringify(mock.localMap.get(SNAPSHOT_KEY)),
    refresh: mock.sessionMap.get(REFRESH_KEY),
    broadcasts: mock.sent.length,
  };
}

describe("request_server_status (worker)", () => {
  it("reads the worker's own run with the session bearer and returns committed counts", async () => {
    const mock = await load();
    const calls = route([fixture.responses.legacy_partial]);
    const before = sideEffects(mock);
    const reply = await mock.dispatch({
      kind: "request_server_status",
      intentId: "imp-FORGED",
    });
    expect(reply).toEqual({
      kind: "server_status",
      state: "known",
      intentId: INTENT,
      status: "partial",
      mode: "legacy",
      settled: true,
      counts: [{ entityType: "clients", committed: 7 }],
    });
    expect(calls.status).toHaveLength(1);
    const [{ url, init }] = calls.status;
    // Own run id only; the caller-supplied id is ignored.
    expect(url).toBe(STATUS_URL);
    expect(url).not.toContain("FORGED");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: "Bearer TGP-ACCESS-1" });
    // Display-only: snapshot, tokens and broadcasts are untouched.
    expect(sideEffects(mock)).toEqual(before);
    expect(JSON.stringify(reply)).not.toContain("TGP-ACCESS");
  });

  it("404 -> not yet known (never 0)", async () => {
    const mock = await load();
    route([fixture.responses.not_found]);
    const reply = await mock.dispatch({ kind: "request_server_status" });
    expect(reply).toEqual({
      kind: "server_status",
      state: "not_yet_known",
      intentId: INTENT,
    });
  });

  it("401 refreshes once, bound to the session, then reads", async () => {
    const mock = await load();
    const calls = route([
      fixture.responses.unauthorized,
      fixture.responses.legacy_running,
    ]);
    const reply = await mock.dispatch({ kind: "request_server_status" });
    expect(reply.state).toBe("known");
    expect(reply.status).toBe("running");
    expect(reply.settled).toBe(false);
    expect(calls.refresh).toBe(2);
    expect(calls.status.map(({ init }) => init.headers.Authorization)).toEqual([
      "Bearer TGP-ACCESS-1",
      "Bearer TGP-ACCESS-2",
    ]);
  });

  it("a second 401 is unavailable: tokens kept, no auth_required, no broadcast", async () => {
    const mock = await load();
    route([fixture.responses.unauthorized, fixture.responses.unauthorized]);
    const before = sideEffects(mock);
    const reply = await mock.dispatch({ kind: "request_server_status" });
    expect(reply).toEqual({ kind: "server_status", state: "unavailable" });
    expect(sideEffects(mock)).toEqual(before);
    expect(mock.sent.some((m) => m && m.kind === "auth_required")).toBe(false);
  });

  it.each(["forbidden", "rate_limited", "bad_request"])(
    "%s -> unavailable",
    async (name) => {
      const mock = await load();
      route([fixture.responses[name]]);
      const reply = await mock.dispatch({ kind: "request_server_status" });
      expect(reply).toEqual({ kind: "server_status", state: "unavailable" });
    },
  );

  it("a transport fault is unavailable and leaks no detail", async () => {
    const mock = await load();
    route([new Error("PRIVATE transport detail")]);
    const reply = await mock.dispatch({ kind: "request_server_status" });
    expect(reply).toEqual({ kind: "server_status", state: "unavailable" });
  });

  it("no recorded run -> no_run, and nothing is fetched", async () => {
    const mock = await load({ snapshot: null });
    route([]);
    const reply = await mock.dispatch({ kind: "request_server_status" });
    expect(reply).toEqual({ kind: "server_status", state: "no_run" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("no session -> unavailable without a status request", async () => {
    const mock = await load({ session: false });
    const calls = route([]);
    const reply = await mock.dispatch({ kind: "request_server_status" });
    expect(reply).toEqual({ kind: "server_status", state: "unavailable" });
    expect(calls.status).toHaveLength(0);
  });

  it("refuses a content-script principal before spending the bearer", async () => {
    const mock = await load();
    route([fixture.responses.legacy_partial]);
    const reply = await mock.dispatch(
      { kind: "request_server_status" },
      {
        id: "test-extension-id",
        url: "https://app.truecoach.co/clients",
        tab: { id: 9 },
      },
    );
    expect(reply).toEqual({ ok: false, error: "untrusted_sender" });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
