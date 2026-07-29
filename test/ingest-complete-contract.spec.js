import { describe, it, expect, vi } from "vitest";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";
import { fakePageStore, realSourceTab } from "./helpers/source-tab.js";

// Wire-level coverage of what background.js actually POSTs to
// /api/scout/ingest/complete and /api/scout/progress.
//
// The backend runs a global ValidationPipe with { whitelist: true,
// forbidNonWhitelisted: true }. That makes the complete body a strict contract:
//   - `terminal_status` is REQUIRED and must be one of success|partial|failed;
//   - `platform` is NOT on ScoutCompleteDto, so sending it is a 400.
// The extension previously sent { intent_id, platform } and no terminal_status,
// which means every single complete was rejected and every import intent stayed
// "running" on the backend forever. These tests assert the real serialized body,
// not a reconstruction, so the contract cannot silently drift again.

// A full crawl paces its source requests, so a whole run can outlast the default
// 5s budget. A timed-out run keeps executing and leaks into the next test's
// shared global.fetch, so the budget has to cover the slowest real run.
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

// The exact enum ScoutCompleteDto accepts. Anything else is a 400.
const TERMINAL_STATUSES = ["success", "partial", "failed"];

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

// Route the whole run. `clients` is the first source page's payload; every later
// page is empty so the crawl terminates. Records every complete/progress body.
function routeRun(mock, { clients, notes = [], sourceStatus = 200 } = {}) {
    const completeBodies = [];
    const progressBodies = [];
    global.fetch.mockImplementation(async (url, init) => {
        if (url === REFRESH_URL) {
            return { ok: true, status: 200, json: async () => ({ access_token: "TGP-ACCESS" }) };
        }
        if (url.startsWith(CLIENTS_PREFIX)) {
            if (sourceStatus !== 200) {
                return { ok: false, status: sourceStatus, headers: new Headers({}), json: async () => ({}) };
            }
            const page = url.includes("page=1") ? clients : [];
            return { ok: true, status: 200, json: async () => ({ clients: page }) };
        }
        if (url.startsWith(NOTES_PREFIX)) {
            return { ok: true, status: 200, json: async () => ({ notes }) };
        }
        if (url === INGEST_URL) {
            return { ok: true, status: 200 };
        }
        if (url === PROGRESS_URL) {
            progressBodies.push(JSON.parse(init.body));
            return { ok: true, status: 204 };
        }
        if (url === COMPLETE_URL) {
            completeBodies.push(JSON.parse(init.body));
            return { ok: true, status: 200 };
        }
        throw new Error(`unrouted fetch ${url}`);
    });
    return { completeBodies, progressBodies };
}

describe("ingest/complete — required terminal_status", () => {
    it("sends terminal_status success for a populated clean walk", async () => {
        const mock = await load(withSourceTab());
        const { completeBodies } = routeRun(mock, { clients: [{ id: "c1" }], notes: [{ id: "n1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        expect(await settle(mock)).toBe("ingest_succeeded");
        expect(completeBodies).toHaveLength(1);
        expect(completeBodies[0].terminal_status).toBe("success");
    });

    it("uses the backend's enum member 'success', never the engine's word 'complete'", async () => {
        const mock = await load(withSourceTab());
        const { completeBodies } = routeRun(mock, { clients: [{ id: "c1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        expect(completeBodies[0].terminal_status).not.toBe("complete");
        expect(TERMINAL_STATUSES).toContain(completeBodies[0].terminal_status);
    });

    it("sends terminal_status partial for a clean zero-entity (drift) walk", async () => {
        const mock = await load(withSourceTab());
        const { completeBodies } = routeRun(mock, { clients: [] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        expect(await settle(mock)).toBe("ingest_empty");
        expect(completeBodies[0].terminal_status).toBe("partial");
    });

    it("settles a failed walk instead of leaving the intent running forever", async () => {
        const mock = await load(withSourceTab());
        const { completeBodies } = routeRun(mock, { clients: [], sourceStatus: 404 });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        expect(await settle(mock)).toBe("ingest_failed");
        expect(completeBodies).toHaveLength(1);
        expect(completeBodies[0].terminal_status).toBe("failed");
    });

    it("still surfaces the source failure to the coach when the settlement itself fails", async () => {
        const mock = await load(withSourceTab());
        routeRun(mock, { clients: [], sourceStatus: 500 });
        const inner = global.fetch.getMockImplementation();
        global.fetch.mockImplementation(async (url, init) => {
            if (url === COMPLETE_URL) {
                return { ok: false, status: 503 };
            }
            return inner(url, init);
        });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        expect(await settle(mock)).toBe("ingest_failed");
        // The 503 from complete must NOT mask the source status the coach needs.
        expect(snapshots(mock).at(-1).lastError).toMatch(/500/);
    });
});

describe("ingest/complete — strict DTO whitelist", () => {
    it("never sends `platform` (not on ScoutCompleteDto, so forbidNonWhitelisted 400s)", async () => {
        const mock = await load(withSourceTab());
        const { completeBodies } = routeRun(mock, { clients: [{ id: "c1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        expect("platform" in completeBodies[0]).toBe(false);
    });

    it("sends only fields declared on ScoutCompleteDto", async () => {
        const mock = await load(withSourceTab());
        const { completeBodies } = routeRun(mock, { clients: [{ id: "c1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        const allowed = new Set(["intent_id", "terminal_status", "final_counts", "error_summary"]);
        for (const key of Object.keys(completeBodies[0])) {
            expect(allowed.has(key)).toBe(true);
        }
    });

    it("carries the run's intent_id", async () => {
        const mock = await load(withSourceTab());
        const { completeBodies } = routeRun(mock, { clients: [{ id: "c1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        const intentId = snapshots(mock).at(-1).intent.intentId;
        expect(completeBodies[0].intent_id).toBe(intentId);
        expect(completeBodies[0].intent_id.length).toBeLessThanOrEqual(128);
    });

    it("reports final_counts and omits error_summary on a clean success", async () => {
        const mock = await load(withSourceTab());
        const { completeBodies } = routeRun(mock, { clients: [{ id: "c1" }], notes: [{ id: "n1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        // Per ENTITY TYPE, matching the entity_type vocabulary the progress stream
        // already uses. "pages" is not an entity and a bare total cannot tell a
        // coach whether their notes came across.
        expect(completeBodies[0].final_counts).toEqual({ clients: 1, notes: 1 });
        expect("error_summary" in completeBodies[0]).toBe(false);
    });

    it("never reports pages or a bare total as if they were entity types", async () => {
        const mock = await load(withSourceTab());
        const { completeBodies } = routeRun(mock, { clients: [{ id: "c1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        expect("pages" in completeBodies[0].final_counts).toBe(false);
        expect("entities" in completeBodies[0].final_counts).toBe(false);
    });

    it("keeps a zero-yield entity type visible in the tally", async () => {
        // A drifted step that returns nothing must appear as 0, not vanish: an
        // absent key is indistinguishable from a step that was never attempted.
        const mock = await load(withSourceTab());
        const { completeBodies } = routeRun(mock, { clients: [{ id: "c1" }], notes: [] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        expect(completeBodies[0].final_counts).toEqual({ clients: 1, notes: 0 });
    });

    it("attaches a bounded error_summary explaining an empty walk", async () => {
        const mock = await load(withSourceTab());
        const { completeBodies } = routeRun(mock, { clients: [] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        expect(completeBodies[0].error_summary).toMatch(/no records found/);
        expect(completeBodies[0].error_summary.length).toBeLessThanOrEqual(2000);
    });

    it("posts complete with the TGP bearer, as JSON", async () => {
        const mock = await load(withSourceTab());
        routeRun(mock, { clients: [{ id: "c1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        const call = global.fetch.mock.calls.find(([url]) => url === COMPLETE_URL);
        expect(call[1].method).toBe("POST");
        expect(call[1].headers.Authorization).toBe("Bearer TGP-ACCESS");
        expect(call[1].headers["Content-Type"]).toBe("application/json");
    });
});

describe("empty outcome — surfaced, not swallowed", () => {
    it("reports a distinct ingest_empty state rather than ingest_succeeded", async () => {
        const mock = await load(withSourceTab());
        routeRun(mock, { clients: [] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        expect(await settle(mock)).toBe("ingest_empty");
    });

    it("explains the likely cause without claiming the coach has no data", async () => {
        const mock = await load(withSourceTab());
        routeRun(mock, { clients: [] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        const lastError = snapshots(mock).at(-1).lastError;
        expect(lastError).toMatch(/out of date/);
        expect(lastError).toMatch(/Nothing was changed/);
    });
});

describe("outcome notification — the most visible surface must not overclaim", () => {
    it("does not say the import is complete when the walk was empty", async () => {
        const mock = await load(withSourceTab());
        routeRun(mock, { clients: [] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        expect(await settle(mock)).toBe("ingest_empty");
        const message = mock.notifications.at(-1).message;
        expect(message).not.toMatch(/complete/);
        expect(message).toMatch(/no records/);
    });

    it("still says complete for a genuinely clean populated walk", async () => {
        const mock = await load(withSourceTab());
        routeRun(mock, { clients: [{ id: "c1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        expect(await settle(mock)).toBe("ingest_succeeded");
        expect(mock.notifications.at(-1).message).toMatch(/complete/);
    });

    it("raises no notification at all on a failed walk", async () => {
        const mock = await load(withSourceTab());
        routeRun(mock, { clients: [], sourceStatus: 404 });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        expect(await settle(mock)).toBe("ingest_failed");
        expect(mock.notifications).toHaveLength(0);
    });
});

describe("/api/scout/progress — live wiring", () => {
    it("posts progress with the DTO field names during a real run", async () => {
        const mock = await load(withSourceTab());
        const { progressBodies } = routeRun(mock, { clients: [{ id: "c1" }], notes: [{ id: "n1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        expect(progressBodies.length).toBeGreaterThan(0);
        const body = progressBodies[0];
        expect(typeof body.intent_id).toBe("string");
        expect(typeof body.deviceId).toBe("string");
        expect(Array.isArray(body.progress)).toBe(true);
        expect(body.progress.length).toBeLessThanOrEqual(64);
    });

    it("mints and persists a non-secret device id in local storage", async () => {
        const mock = await load(withSourceTab());
        const { progressBodies } = routeRun(mock, { clients: [{ id: "c1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        const stored = mock.localMap.get("tgp_device_id");
        expect(typeof stored).toBe("string");
        expect(stored.length).toBeGreaterThan(0);
        expect(stored.length).toBeLessThanOrEqual(64);
        expect(progressBodies[0].deviceId).toBe(stored);
        // A device id is not a credential: it must never be the refresh token.
        expect(stored).not.toBe("seed-refresh");
    });

    it("reuses the persisted device id across runs rather than minting a new one", async () => {
        const mock = await load(withSourceTab());
        routeRun(mock, { clients: [{ id: "c1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        const first = mock.localMap.get("tgp_device_id");
        mock.sent.length = 0;
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        expect(mock.localMap.get("tgp_device_id")).toBe(first);
    });

    it("does not fail the import when every progress post is rejected", async () => {
        const mock = await load(withSourceTab());
        routeRun(mock, { clients: [{ id: "c1" }] });
        const inner = global.fetch.getMockImplementation();
        global.fetch.mockImplementation(async (url, init) => {
            if (url === PROGRESS_URL) {
                return { ok: false, status: 429 };
            }
            return inner(url, init);
        });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        expect(await settle(mock)).toBe("ingest_succeeded");
    });

    it("does not fail the import when the device id cannot be read or persisted", async () => {
        // Progress is strictly advisory. If chrome.storage.local is unavailable
        // the reporter must simply go quiet — a reporting-channel fault can never
        // be allowed to cost the coach their migration.
        const mock = await load(withSourceTab());
        mock.chrome.storage.local.get = async () => { throw new Error("storage unavailable"); };
        const { progressBodies } = routeRun(mock, { clients: [{ id: "c1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        expect(await settle(mock)).toBe("ingest_succeeded");
        expect(progressBodies).toHaveLength(0);
    });

    it("never puts token material on the progress wire", async () => {
        const mock = await load(withSourceTab());
        const { progressBodies } = routeRun(mock, { clients: [{ id: "c1" }] });
        await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
        await settle(mock);
        const serialized = JSON.stringify(progressBodies);
        expect(serialized).not.toContain(SRC_JWT);
        expect(serialized).not.toContain("TGP-ACCESS");
        expect(serialized).not.toContain("seed-refresh");
    });
});
