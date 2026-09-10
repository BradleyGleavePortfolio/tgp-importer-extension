import { describe, it, expect, vi } from "vitest";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";
import { fakePageStore, realSourceTab } from "./helpers/source-tab.js";

// Wire-level coverage of the settlement path for a run that THREW rather than
// returned a terminal result.
//
// A source 401/403 is fail-closed by design: makeSourceFetch raises AuthLostError
// and the engine propagates it, so runReplay never returns. That escape hatch
// bypassed the only call to /api/scout/ingest/complete, so the extension told the
// coach "import failed" while the backend intent stayed `running` forever — the
// same silent-divergence defect as a rejected complete, reached by a different
// door. It is the single most likely failure of a real crawl: a source session
// expiring mid-import is routine.
//
// These tests assert the real serialized wire bodies and their ORDER against the
// popup broadcast, not a reconstruction.

vi.setConfig({ testTimeout: 30000 });

const REFRESH_KEY = "tgp_refresh_token";
const REFRESH_URL = "https://api.tgp.coach/api/auth/extension/refresh";
const INGEST_URL = "https://api.tgp.coach/api/scout/ingest";
const COMPLETE_URL = "https://api.tgp.coach/api/scout/ingest/complete";
const PROGRESS_URL = "https://api.tgp.coach/api/scout/progress";
const CLIENTS_PREFIX = "https://app.truecoach.co/proxy/api/clients?";
const NOTES_PREFIX = "https://app.truecoach.co/proxy/api/clients/";
const TAB_URL = "https://app.truecoach.co/clients";
const TAB_ID = 42;
const SRC_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb2FjaCJ9.s1g-nature_TOKEN";
const EXT_ID = "test-extension-id";

const TERMINAL_STATUSES = ["success", "partial", "failed"];
const COMPLETE_FIELDS = new Set([
  "intent_id",
  "terminal_status",
  "final_counts",
  "error_summary",
]);

function withSourceTab() {
  const stores = [fakePageStore(), fakePageStore([["truecoach.jwt", SRC_JWT]])];
  return { url: TAB_URL, sendMessage: realSourceTab(EXT_ID, stores) };
}

async function load(tab) {
  vi.resetModules();
  const mock = makeBgMock({
    session: new Map([[REFRESH_KEY, "seed-refresh"]]),
    tab,
  });
  installChrome(mock);
  global.fetch = vi.fn();
  await import("../background.js");
  return mock;
}

function snapshots(mock) {
  return mock.sent.filter((m) => m && m.kind === "status_snapshot");
}

function sawFailed(mock) {
  return snapshots(mock).some(
    (s) => s.intent && s.intent.status === "ingest_failed",
  );
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
      status === "ingest_empty"
    ) {
      return status;
    }
    if (Date.now() - start > ms) {
      return status;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Route a run. `sourceStatus` is what every source page answers with; `clients`
// feeds the first page when the source is healthy. Records every complete body
// and, alongside each one, whether the coach had ALREADY been shown a terminal
// failure at the moment that complete went out.
function routeRun(
  mock,
  {
    clients = [],
    notes = [],
    sourceStatus = 200,
    notesStatus = 200,
    completeStatus = 200,
    ingestStatus = 200,
    refreshOk = true,
  } = {},
) {
  const completeBodies = [];
  const failedBroadcastFirst = [];
  const progressBodies = [];
  // How many progress posts had landed at the moment each complete went out.
  const progressAtComplete = [];
  // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
  global.fetch.mockImplementation(async (url, init) => {
    if (url === REFRESH_URL) {
      return refreshOk
        ? {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "TGP-ACCESS" }),
          }
        : { ok: false, status: 401, json: async () => ({}) };
    }
    if (url.startsWith(CLIENTS_PREFIX)) {
      if (sourceStatus !== 200) {
        return {
          ok: false,
          status: sourceStatus,
          headers: new Headers({}),
          json: async () => ({}),
        };
      }
      const page = url.includes("page=1") ? clients : [];
      return { ok: true, status: 200, json: async () => ({ clients: page }) };
    }
    if (url.startsWith(NOTES_PREFIX)) {
      if (notesStatus !== 200) {
        return {
          ok: false,
          status: notesStatus,
          headers: new Headers({}),
          json: async () => ({}),
        };
      }
      return { ok: true, status: 200, json: async () => ({ notes }) };
    }
    if (url === INGEST_URL) {
      return { ok: ingestStatus < 300, status: ingestStatus };
    }
    if (url === PROGRESS_URL) {
      progressBodies.push(JSON.parse(init.body));
      return { ok: true, status: 204 };
    }
    if (url === COMPLETE_URL) {
      completeBodies.push(JSON.parse(init.body));
      failedBroadcastFirst.push(sawFailed(mock));
      progressAtComplete.push(progressBodies.length);
      return { ok: completeStatus < 300, status: completeStatus };
    }
    throw new Error(`unrouted fetch ${url}`);
  });
  return {
    completeBodies,
    failedBroadcastFirst,
    progressBodies,
    progressAtComplete,
  };
}

async function runImport(mock, ms) {
  await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
  return settle(mock, ms);
}

describe("source auth loss — the started intent is still settled", () => {
  for (const sourceStatus of [401, 403]) {
    it(`settles terminal_status failed when the source answers ${sourceStatus}`, async () => {
      const mock = await load(withSourceTab());
      const { completeBodies } = routeRun(mock, { sourceStatus });
      expect(await runImport(mock)).toBe("ingest_failed");
      expect(completeBodies).toHaveLength(1);
      expect(completeBodies[0].terminal_status).toBe("failed");
      expect(TERMINAL_STATUSES).toContain(completeBodies[0].terminal_status);
    });
  }

  it("settles BEFORE telling the coach the run is over", async () => {
    // Ordering is the whole point: a broadcast that lands first is a window in
    // which the coach is told the import ended while the backend still has it
    // running, and an MV3 worker suspended in that window never closes it.
    const mock = await load(withSourceTab());
    const { failedBroadcastFirst } = routeRun(mock, { sourceStatus: 401 });
    expect(await runImport(mock)).toBe("ingest_failed");
    expect(failedBroadcastFirst).toEqual([false]);
  });

  it("omits final_counts rather than guessing a tally it does not have", async () => {
    const mock = await load(withSourceTab());
    const { completeBodies } = routeRun(mock, { sourceStatus: 401 });
    await runImport(mock);
    expect("final_counts" in completeBodies[0]).toBe(false);
  });

  it("sends only ScoutCompleteDto fields on the failure settlement", async () => {
    const mock = await load(withSourceTab());
    const { completeBodies } = routeRun(mock, { sourceStatus: 401 });
    await runImport(mock);
    for (const key of Object.keys(completeBodies[0])) {
      expect(COMPLETE_FIELDS.has(key)).toBe(true);
    }
    expect(completeBodies[0].intent_id).toBe(
      snapshots(mock).at(-1).intent.intentId,
    );
  });

  it("carries a bounded, PII-free error_summary and no token material", async () => {
    const mock = await load(withSourceTab());
    const { completeBodies } = routeRun(mock, { sourceStatus: 403 });
    await runImport(mock);
    expect(completeBodies[0].error_summary).toMatch(/source sign-in required/);
    expect(completeBodies[0].error_summary.length).toBeLessThanOrEqual(2000);
    const serialized = JSON.stringify(completeBodies);
    expect(serialized).not.toContain(SRC_JWT);
    expect(serialized).not.toContain("TGP-ACCESS");
    expect(serialized).not.toContain("seed-refresh");
  });

  it("still asks the coach to re-authenticate at the SOURCE, not to re-pair TGP", async () => {
    // Settling must not change the diagnosis: the TGP session is fine, so the
    // coach must not be sent back through pairing.
    const mock = await load(withSourceTab());
    routeRun(mock, { sourceStatus: 401 });
    expect(await runImport(mock)).toBe("ingest_failed");
    expect(snapshots(mock).at(-1).lastError).toMatch(/source sign-in required/);
    expect(mock.sent.some((m) => m && m.kind === "auth_required")).toBe(false);
  });

  it("does not let a failed settlement mask the source failure", async () => {
    const mock = await load(withSourceTab());
    routeRun(mock, { sourceStatus: 401, completeStatus: 503 });
    expect(await runImport(mock)).toBe("ingest_failed");
    expect(snapshots(mock).at(-1).lastError).toMatch(/source sign-in required/);
  });

  it("logs an observable, PII-free signal when the settlement POST itself fails", async () => {
    // The settlement POST is best-effort and must stay non-throwing, but a
    // total failure of it left the intent "running forever" one level deeper
    // with ZERO observability. shared/log.js's logNetworkEvent exists for
    // exactly this: a stable, secret-free event code, not a message body.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mock = await load(withSourceTab());
    routeRun(mock, { sourceStatus: 401, completeStatus: 503 });
    expect(await runImport(mock)).toBe("ingest_failed");
    const lines = warn.mock.calls.map((c) => c[0]);
    const parsed = lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
    expect(
      parsed.some((p) => p && p.event === "settlement_network_error"),
    ).toBe(true);
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain(SRC_JWT);
    expect(serialized).not.toContain("TGP-ACCESS");
    warn.mockRestore();
  });

  it("raises no success notification for a settled failure", async () => {
    const mock = await load(withSourceTab());
    routeRun(mock, { sourceStatus: 401 });
    await runImport(mock);
    expect(mock.notifications).toHaveLength(0);
  });
});

describe("settlement is attempted at most once per intent", () => {
  it("does not re-settle a rejected complete as failed", async () => {
    // The walk succeeded and only the settlement POST was rejected. Retrying it
    // as `failed` would record a failure for a run that did not fail — the
    // backend would be told the coach's data never arrived when it did.
    const mock = await load(withSourceTab());
    const { completeBodies } = routeRun(mock, {
      clients: [{ id: "c1" }],
      notes: [{ id: "n1" }],
      completeStatus: 500,
    });
    expect(await runImport(mock)).toBe("ingest_failed");
    expect(completeBodies).toHaveLength(1);
    expect(completeBodies[0].terminal_status).toBe("success");
  });

  it("settles an engine-reported failure exactly once", async () => {
    const mock = await load(withSourceTab());
    const { completeBodies } = routeRun(mock, { sourceStatus: 404 });
    expect(await runImport(mock)).toBe("ingest_failed");
    expect(completeBodies).toHaveLength(1);
    expect(completeBodies[0].terminal_status).toBe("failed");
  });

  it("logs when the settlement POST fails on an engine-RETURNED failure, not just a throw", async () => {
    // A retryable 5xx that exhausts retries makes runReplay RETURN
    // {status:"failed"} rather than throw — a different call site
    // (background.js's result.status==="failed" branch) posts the complete
    // here. Both settlement-POST-failure call sites must log, not just the
    // one reached via settleFailed on a throw.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mock = await load(withSourceTab());
    routeRun(mock, { sourceStatus: 503, completeStatus: 503 });
    expect(await runImport(mock, 20000)).toBe("ingest_failed");
    const parsed = warn.mock.calls.map((c) => {
      try {
        return JSON.parse(c[0]);
      } catch {
        return null;
      }
    });
    expect(
      parsed.some((p) => p && p.event === "settlement_network_error"),
    ).toBe(true);
    warn.mockRestore();
  }, 25000);
});

describe("completeIngest — refreshes an expired token once, same as sendEntities", () => {
  // sendEntities already refreshes-and-retries once on a 401. completeIngest
  // used to give up immediately on a 401, so a run that fully succeeded (every
  // entity already landed) could still be reported ingest_failed purely
  // because the access token happened to expire in the narrow gap between the
  // last entity send and this call — even though a refresh would have
  // succeeded. This is the false-failure window Finding 3 closes.
  it("settles success after one 401 + refresh + retry on the complete POST", async () => {
    const mock = await load(withSourceTab());
    let completeAttempts = 0;
    let refreshCalls = 0;
    const { completeBodies } = routeRun(mock, {
      clients: [{ id: "c1" }],
      notes: [{ id: "n1" }],
    });
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    const inner = global.fetch.getMockImplementation();
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockImplementation(async (url, init) => {
      if (url === REFRESH_URL) {
        refreshCalls += 1;
      }
      if (url === COMPLETE_URL) {
        completeAttempts += 1;
        if (completeAttempts === 1) {
          return { ok: false, status: 401, json: async () => ({}) };
        }
      }
      return inner(url, init);
    });
    expect(await runImport(mock)).toBe("ingest_succeeded");
    expect(completeAttempts).toBe(2);
    expect(refreshCalls).toBeGreaterThan(0);
    expect(completeBodies).toHaveLength(1);
    expect(completeBodies[0].terminal_status).toBe("success");
  });

  it("does not double-settle or break settlement-before-broadcast ordering on that retry", async () => {
    const mock = await load(withSourceTab());
    let completeAttempts = 0;
    const { completeBodies, failedBroadcastFirst } = routeRun(mock, {
      clients: [{ id: "c1" }],
      notes: [{ id: "n1" }],
    });
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    const inner = global.fetch.getMockImplementation();
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockImplementation(async (url, init) => {
      if (url === COMPLETE_URL) {
        completeAttempts += 1;
        if (completeAttempts === 1) {
          return { ok: false, status: 401, json: async () => ({}) };
        }
      }
      return inner(url, init);
    });
    expect(await runImport(mock)).toBe("ingest_succeeded");
    expect(completeBodies).toHaveLength(1);
    // Only one complete body was ever sent (the retry, not a second settlement
    // attempt), and no failure was ever broadcast on this successful run.
    expect(failedBroadcastFirst).toEqual([false]);
  });

  it("still surfaces ingest_failed if the retried complete also 401s (no refresh available)", async () => {
    // If refresh itself cannot produce a usable token, completeIngest must
    // still fail closed exactly as before — this fix only closes the
    // refreshable-token gap, it must not mask a genuine TGP auth loss here.
    // The initial session bootstrap needs one real refresh to mint the first
    // access token, so only the LATER refresh (triggered by the complete's
    // 401) is made to fail here.
    const mock = await load(withSourceTab());
    let refreshCalls = 0;
    const { completeBodies } = routeRun(mock, {
      clients: [{ id: "c1" }],
      notes: [{ id: "n1" }],
    });
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    const inner = global.fetch.getMockImplementation();
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockImplementation(async (url, init) => {
      if (url === REFRESH_URL) {
        refreshCalls += 1;
        if (refreshCalls > 1) {
          return { ok: false, status: 401, json: async () => ({}) };
        }
      }
      if (url === COMPLETE_URL) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return inner(url, init);
    });
    expect(await runImport(mock)).toBe("ingest_failed");
    // Both the original complete attempt and its retry 401'd (no body was
    // ever accepted), and refresh itself was denied — so unlike the
    // successful-refresh case above, no complete body reaches the mock
    // server here. The run still resolves deterministically to
    // ingest_failed rather than hanging or masking the failure as success.
    expect(completeBodies).toHaveLength(0);
  });
});

describe("TGP auth loss — no settlement is attempted", () => {
  it("routes to pairing without posting a complete it cannot authenticate", async () => {
    // The ingest bearer is gone and refresh is exhausted, so the tokens a
    // complete would carry are the ones just cleared: the POST could only 401.
    // Closing this intent needs a re-pair, not another unauthenticated call.
    const mock = await load(withSourceTab());
    const { completeBodies } = routeRun(mock, {
      clients: [{ id: "c1" }],
      ingestStatus: 401,
      refreshOk: false,
    });
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    await settle(mock, 3000);
    expect(mock.sent.some((m) => m && m.kind === "auth_required")).toBe(true);
    expect(completeBodies).toHaveLength(0);
  });
});

describe("terminal progress flush — the backend's last view is not left mid-crawl", () => {
  // The progress series and the settlement are two halves of one record. If the
  // series stops at whatever the rate limiter last let through, an intent can go
  // terminal with a progress view that still reads as an in-flight crawl —
  // exactly the "is my migration stuck?" ambiguity progress exists to remove.
  // Flushing is bounded and cannot throw, so it costs the run nothing.

  it("flushes the final counts before settling a run that threw", async () => {
    // Clients emit, then the notes step's 401 propagates out of runReplay.
    const mock = await load(withSourceTab());
    const r = routeRun(mock, { clients: [{ id: "c1" }], notesStatus: 401 });
    expect(await runImport(mock)).toBe("ingest_failed");
    expect(r.completeBodies).toHaveLength(1);
    expect(r.progressBodies.length).toBeGreaterThan(0);
    // At least one progress post had landed before the complete went out.
    expect(r.progressAtComplete[0]).toBeGreaterThan(0);
  });

  it("carries the committed counts on that final flush, not a reset", async () => {
    const mock = await load(withSourceTab());
    const r = routeRun(mock, { clients: [{ id: "c1" }], notesStatus: 401 });
    await runImport(mock);
    const last = r.progressBodies.at(-1);
    expect(last.progress.length).toBeGreaterThan(0);
    expect(last.progress.some((row) => row.count_committed > 0)).toBe(true);
  });

  it("still settles when every progress post is rejected", async () => {
    // Progress is advisory: a flush that fails must not cost the coach the
    // settlement that keeps their intent from sitting "running" forever.
    const mock = await load(withSourceTab());
    const r = routeRun(mock, { clients: [{ id: "c1" }], notesStatus: 401 });
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    const inner = global.fetch.getMockImplementation();
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockImplementation(async (url, init) =>
      url === PROGRESS_URL ? { ok: false, status: 429 } : inner(url, init),
    );
    expect(await runImport(mock)).toBe("ingest_failed");
    expect(r.completeBodies).toHaveLength(1);
    expect(r.completeBodies[0].terminal_status).toBe("failed");
  });

  it("puts no token material on that final flush", async () => {
    const mock = await load(withSourceTab());
    const r = routeRun(mock, { clients: [{ id: "c1" }], notesStatus: 401 });
    await runImport(mock);
    const serialized = JSON.stringify(r.progressBodies);
    expect(serialized).not.toContain(SRC_JWT);
    expect(serialized).not.toContain("TGP-ACCESS");
    expect(serialized).not.toContain("seed-refresh");
  });
});
