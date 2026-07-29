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
const COMPLETE_FIELDS = new Set(["intent_id", "terminal_status", "final_counts", "error_summary"]);

function withSourceTab() {
    const stores = [fakePageStore(), fakePageStore([["truecoach.jwt", SRC_JWT]])];
    return { url: TAB_URL, sendMessage: realSourceTab(EXT_ID, stores) };
}

async function load(tab) {
    vi.resetModules();
    const mock = makeBgMock({ session: new Map([[REFRESH_KEY, "seed-refresh"]]), tab });
    installChrome(mock);
    global.fetch = vi.fn();
    await import("../background.js");
    return mock;
}

function snapshots(mock) {
    return mock.sent.filter((m) => m && m.kind === "status_snapshot");
}

function sawFailed(mock) {
    return snapshots(mock).some((s) => s.intent && s.intent.status === "ingest_failed");
}

async function settle(mock, ms = 10000) {
    const start = Date.now();
    for (;;) {
        const last = snapshots(mock).at(-1);
        const status = last && last.intent ? last.intent.status : null;
        if (status === "ingest_succeeded" || status === "ingest_failed"
            || status === "ingest_partial" || status === "ingest_empty") {
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
function routeRun(mock, {
    clients = [],
    notes = [],
    sourceStatus = 200,
    notesStatus = 200,
    completeStatus = 200,
    ingestStatus = 200,
    refreshOk = true,
} = {}) {
    const completeBodies = [];
    const failedBroadcastFirst = [];
    const progressBodies = [];
    // How many progress posts had landed at the moment each complete went out.
    const progressAtComplete = [];
    global.fetch.mockImplementation(async (url, init) => {
        if (url === REFRESH_URL) {
            return refreshOk
                ? { ok: true, status: 200, json: async () => ({ access_token: "TGP-ACCESS" }) }
                : { ok: false, status: 401, json: async () => ({}) };
        }
        if (url.startsWith(CLIENTS_PREFIX)) {
            if (sourceStatus !== 200) {
                return { ok: false, status: sourceStatus, headers: new Headers({}), json: async () => ({}) };
            }
            const page = url.includes("page=1") ? clients : [];
            return { ok: true, status: 200, json: async () => ({ clients: page }) };
        }
        if (url.startsWith(NOTES_PREFIX)) {
            if (notesStatus !== 200) {
                return { ok: false, status: notesStatus, headers: new Headers({}), json: async () => ({}) };
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
    return { completeBodies, failedBroadcastFirst, progressBodies, progressAtComplete };
}

async function runImport(mock) {
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    return settle(mock);
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
        expect(completeBodies[0].intent_id).toBe(snapshots(mock).at(-1).intent.intentId);
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
        const inner = global.fetch.getMockImplementation();
        global.fetch.mockImplementation(async (url, init) => (url === PROGRESS_URL
            ? { ok: false, status: 429 }
            : inner(url, init)));
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
