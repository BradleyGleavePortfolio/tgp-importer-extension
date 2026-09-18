import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptedIngest,
  installChrome,
  makeBgMock,
} from "./helpers/background-mock.js";
import { outcomeView } from "../popup/outcome.js";

const api = "https://api.tgp.coach/api";
const source = "https://app.truecoach.co";
const snapshotKey = "tgp_status_snapshot";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function transfer(mode, entrypoint = "start_import") {
  vi.resetModules();
  vi.useFakeTimers();
  const mock = makeBgMock({
    tab: { url: `${source}/clients`, token: "source.session.token" },
  });
  installChrome(mock);
  const writes = [];
  const settlements = [];
  let ingests = 0;
  const fetchMock = vi.fn(async (url, init) => {
    if (url === `${api}/scout/progress`)
      return new Response(null, { status: 204 });
    if (url === `${api}/auth/extension/refresh`)
      return Response.json({ access_token: "fresh" });
    if (url === `${api}/scout/ingest/complete`) {
      settlements.push(JSON.parse(init.body));
      return new Response(null, { status: mode === "settlement" ? 500 : 204 });
    }
    if (url === `${api}/scout/ingest`) {
      ingests += 1;
      const body = JSON.parse(init.body);
      writes.push(body);
      if (ingests === 1) return acceptedIngest(init);
      if (mode === "timeout") return new Promise(() => {});
      if (mode === "network") throw new Error("synthetic disconnect");
      if (mode === "refresh" && ingests === 2)
        return new Response(null, { status: 401 });
      if (mode === "reject") return new Response(null, { status: 503 });
      if (mode === "ok" || mode === "settlement") return acceptedIngest(init);
      return Response.json({});
    }
    if (String(url).includes("/notes")) return Response.json({ notes: [] });
    if (String(url).startsWith(`${source}/proxy/api/clients?`)) {
      const page = new URL(url).searchParams.get("page");
      if (mode === "source" && page === "2")
        return new Response(null, { status: 503 });
      return Response.json({
        clients:
          page === "1"
            ? [{ id: "c0" }]
            : page === "2"
              ? Array.from({ length: 22 }, (_, i) => ({ id: `c${i + 1}` }))
              : [],
      });
    }
    // Legacy extractor requests its other supported empty collections.
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  await import("../background.js");
  await mock.dispatch({
    kind: "session_established",
    accessToken: "access",
    refreshToken: "refresh",
  });
  await mock.dispatch({
    kind: entrypoint,
    url: `${source}/clients`,
    tabId: 42,
    sourceToken: "source",
  });
  await vi.advanceTimersByTimeAsync(65000);
  const snapshot = await mock.dispatch({ kind: "request_status" });
  return { mock, snapshot, writes, settlements, fetchMock };
}

describe("outstanding batch evidence through the actual worker", () => {
  it.each(["invalid", "network", "timeout", "reject"])(
    "retains 22 unconfirmed client records and the earlier receipt after %s",
    async (mode) => {
      const result = await transfer(mode);
      expect(result.snapshot.intent.status).toBe("ingest_failed");
      expect(result.snapshot.pendingTransfer).toEqual({
        entityType: "clients",
        count: 22,
      });
      expect(result.snapshot.staging.clients).toEqual({
        received: 1,
        inserted: 1,
        deduped: 0,
      });
      expect(result.snapshot.workerActive).toBe(false);
      expect(result.writes).toHaveLength(2);
      expect(result.settlements[0].final_counts).toEqual({ clients: 1 });
      const view = outcomeView(
        result.snapshot,
        result.mock.chrome.i18n.getMessage,
      );
      expect(view.lines[0].unconfirmed).toContain("22 unconfirmed");
      expect(view.lines[0].receipt).toContain("1 confirmed received");
      expect(view.summary).not.toContain("22 clients lost");
      expect(result.mock.localMap.get(snapshotKey).pendingTransfer.count).toBe(
        22,
      );
      expect(result.mock.localMap.get(snapshotKey)).not.toHaveProperty(
        "workerActive",
      );
    },
  );

  it("does not double-count one batch when the existing auth retry occurs", async () => {
    const result = await transfer("refresh");
    expect(result.writes).toHaveLength(3);
    expect(result.writes[1]).toEqual(result.writes[2]);
    expect(result.snapshot.pendingTransfer.count).toBe(22);
    expect(result.snapshot.staging.clients.received).toBe(1);
    expect(result.settlements[0].final_counts.clients).toBe(1);
  });

  it("clears pending evidence only when all expected records have a validated receipt", async () => {
    const result = await transfer("ok");
    expect(result.snapshot.pendingTransfer).toBeNull();
    expect(result.snapshot.staging.clients.received).toBe(23);
    expect(result.snapshot.intent.status).toBe("ingest_succeeded");
    expect(result.settlements[0].final_counts.clients).toBe(23);
    const view = outcomeView(
      result.snapshot,
      result.mock.chrome.i18n.getMessage,
    );
    expect(view.lines[0].unconfirmed).toBe("");
    expect(view.native).toContain("not verified");
  });

  it("does not relabel acknowledged data as unconfirmed when final settlement fails", async () => {
    const result = await transfer("settlement");
    expect(result.snapshot.intent.status).toBe("ingest_failed");
    expect(result.snapshot.pendingTransfer).toBeNull();
    expect(result.snapshot.staging.clients.received).toBe(23);
    expect(result.snapshot.lastError).toBe("complete 500");
    const view = outcomeView(
      result.snapshot,
      result.mock.chrome.i18n.getMessage,
    );
    expect(view.issue).toContain("final status");
    expect(view.lines[0].receipt).toContain("23 confirmed");
  });

  it("leaves skipped source-page record counts unknown, never substitutes a page count", async () => {
    const result = await transfer("source");
    expect(result.snapshot.intent.status).toBe("ingest_partial");
    expect(result.snapshot.pendingTransfer).toBeNull();
    expect(result.snapshot.staging.clients.received).toBe(1);
    const view = outcomeView(
      result.snapshot,
      result.mock.chrome.i18n.getMessage,
    );
    expect(view.issue).toContain("record counts are unknown");
    expect(view.lines[0].unconfirmed).toBe("");
    expect(result.writes).toHaveLength(1);
  });

  it("counts only metadata in the persisted pending batch", async () => {
    const result = await transfer("invalid");
    const pending = result.mock.localMap.get(snapshotKey).pendingTransfer;
    expect(Object.keys(pending).sort()).toEqual(["count", "entityType"]);
    expect(JSON.stringify(pending)).not.toMatch(/sourceId|payload|token|c22/);
  });

  it("status inspection has no new source or write requests", async () => {
    const result = await transfer("invalid");
    const previous = result.fetchMock.mock.calls.length;
    const first = await result.mock.dispatch({ kind: "request_status" });
    const second = await result.mock.dispatch({ kind: "request_status" });
    expect(first).toEqual(second);
    expect(result.fetchMock.mock.calls).toHaveLength(previous);
    expect(second.pendingTransfer.count).toBe(22);
  });

  it("a cold worker does not treat an old running snapshot as active work", async () => {
    vi.resetModules();
    const mock = makeBgMock();
    mock.localMap.set(snapshotKey, {
      kind: "status_snapshot",
      intent: { intentId: "old", status: "ingest_started" },
      progress: [],
      staging: { clients: { received: 1, inserted: 1, deduped: 0 } },
      pendingTransfer: { entityType: "clients", count: 22 },
      // Even a historically persisted claim is overridden by current liveness.
      workerActive: true,
    });
    installChrome(mock);
    vi.stubGlobal("fetch", vi.fn());
    await import("../background.js");
    const snapshot = await mock.dispatch({ kind: "request_status" });
    expect(snapshot.workerActive).toBe(false);
    expect(snapshot.pendingTransfer.count).toBe(22);
    expect(outcomeView(snapshot, mock.chrome.i18n.getMessage).title).toContain(
      "needs checking",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("live status is not overwritten by older disk evidence", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const mock = makeBgMock({
      tab: { url: `${source}/clients`, token: "source.session.token" },
    });
    installChrome(mock);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    await import("../background.js");
    await mock.dispatch({
      kind: "session_established",
      accessToken: "access",
      refreshToken: "refresh",
    });
    await mock.dispatch({
      kind: "start_import",
      url: `${source}/clients`,
      tabId: 42,
    });
    await vi.advanceTimersByTimeAsync(1);
    mock.localMap.set(snapshotKey, {
      kind: "status_snapshot",
      intent: null,
      progress: [],
    });
    const snapshot = await mock.dispatch({ kind: "request_status" });
    expect(snapshot.workerActive).toBe(true);
    expect(snapshot.intent.status).toBe("ingest_started");
    expect(outcomeView(snapshot, mock.chrome.i18n.getMessage).title).toBe(
      "Bringing records across",
    );
  });
});
