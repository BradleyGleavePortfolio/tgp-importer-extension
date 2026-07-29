import { describe, it, expect, vi } from "vitest";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";

// Wire-level coverage of the LEGACY `start_ingest` entrypoint's settlement.
//
// This path runs the hand-written TrueCoachExtractor rather than the replay
// engine. It is unreachable from the shipped popup (popup.js only ever sends
// `start_import`), but it is still a live message handler, and it used to post a
// bare `terminal_status: success` with no counts at all — so an extractor whose
// selectors had drifted emitted nothing and the coach was told the import
// completed. That is defect 4 in its purest form.
//
// The extractor keeps no tally of its own, so makeSender keeps one for it,
// incremented only AFTER the backend acks each batch. These tests assert the real
// serialized complete body: an empty run settles `partial` (engine word `empty`)
// with an error_summary, a populated run settles `success` with a per-entity
// final_counts, and a batch the backend rejected is never counted.

vi.setConfig({ testTimeout: 60000 });

const REFRESH_KEY = "tgp_refresh_token";
const REFRESH_URL = "https://api.tgp.coach/api/auth/extension/refresh";
const INGEST_URL = "https://api.tgp.coach/api/scout/ingest";
const COMPLETE_URL = "https://api.tgp.coach/api/scout/ingest/complete";
const PROGRESS_URL = "https://api.tgp.coach/api/scout/progress";
const SRC_BASE = "https://app.truecoach.co/proxy/api";
const TAB_URL = "https://app.truecoach.co/clients";
const SRC_TOKEN = "src.legacy.TOKEN";

const COMPLETE_FIELDS = new Set(["intent_id", "terminal_status", "final_counts", "error_summary"]);

async function load() {
    vi.resetModules();
    const mock = makeBgMock({ session: new Map([[REFRESH_KEY, "seed-refresh"]]) });
    installChrome(mock);
    global.fetch = vi.fn();
    await import("../background.js");
    return mock;
}

function snapshots(mock) {
    return mock.sent.filter((m) => m && m.kind === "status_snapshot");
}

async function settle(mock, ms = 45000) {
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

// Route a legacy run. Every source path answers 200 with `sourceBodies[path]` if
// present, else `{}` — which every TrueCoach parser treats permissively as empty,
// so the default is a clean walk that yields nothing at all.
function routeRun(mock, { sourceBodies = {}, ingestStatus = () => 200 } = {}) {
    const completeBodies = [];
    const progressBodies = [];
    const ingested = [];
    global.fetch.mockImplementation(async (url, init) => {
        if (url === REFRESH_URL) {
            return { ok: true, status: 200, json: async () => ({ access_token: "TGP-ACCESS" }) };
        }
        if (url === INGEST_URL) {
            const body = JSON.parse(init.body);
            ingested.push(body);
            const status = ingestStatus(body);
            return { ok: status < 300, status };
        }
        if (url === PROGRESS_URL) {
            progressBodies.push(JSON.parse(init.body));
            return { ok: true, status: 204 };
        }
        if (url === COMPLETE_URL) {
            completeBodies.push(JSON.parse(init.body));
            return { ok: true, status: 200 };
        }
        if (typeof url === "string" && url.startsWith(SRC_BASE)) {
            const path = url.slice(SRC_BASE.length);
            const payload = sourceBodies[path] ?? {};
            return {
                ok: true,
                status: 200,
                headers: new Headers({ "content-type": "application/json" }),
                json: async () => payload,
                text: async () => JSON.stringify(payload),
            };
        }
        throw new Error(`unrouted fetch ${url}`);
    });
    return { completeBodies, progressBodies, ingested };
}

function runLegacy(mock) {
    return mock.dispatch({ kind: "start_ingest", url: TAB_URL, sourceToken: SRC_TOKEN });
}

describe("legacy start_ingest — a walk that emitted nothing is not a success", () => {
    it("settles terminal_status partial, not success, and shows the coach ingest_empty", async () => {
        // Every source endpoint answers 200 with an empty envelope: nothing looks
        // wrong, and zero records come out. Reporting that as `success` is exactly
        // the silent-data-loss failure this rung exists to remove.
        const mock = await load();
        const r = routeRun(mock);
        await runLegacy(mock);
        expect(await settle(mock)).toBe("ingest_empty");
        expect(r.ingested).toHaveLength(0);
        expect(r.completeBodies).toHaveLength(1);
        expect(r.completeBodies[0].terminal_status).toBe("partial");
    });

    it("carries an error_summary telling the coach to verify, and an empty tally", async () => {
        const mock = await load();
        const r = routeRun(mock);
        await runLegacy(mock);
        await settle(mock);
        expect(r.completeBodies[0].error_summary).toMatch(/no records found/i);
        expect(r.completeBodies[0].final_counts).toEqual({});
    });

    it("sends only ScoutCompleteDto fields and no token material", async () => {
        const mock = await load();
        const r = routeRun(mock);
        await runLegacy(mock);
        await settle(mock);
        for (const key of Object.keys(r.completeBodies[0])) {
            expect(COMPLETE_FIELDS.has(key)).toBe(true);
        }
        const serialized = JSON.stringify(r.completeBodies);
        expect(serialized).not.toContain(SRC_TOKEN);
        expect(serialized).not.toContain("TGP-ACCESS");
        expect(serialized).not.toContain("seed-refresh");
    });

    it("does not raise an OS notification claiming the import completed", async () => {
        // The notification is often the only surface a coach sees, so it must not
        // say "complete" for the outcome the popup is flagging as empty.
        const mock = await load();
        routeRun(mock);
        await runLegacy(mock);
        await settle(mock);
        expect(mock.notifications).toHaveLength(1);
        expect(mock.notifications[0].message).toMatch(/no records/i);
        expect(mock.notifications[0].message).not.toMatch(/complete\./);
    });
});

describe("legacy start_ingest — a populated walk reports a per-entity tally", () => {
    // One organization yields a trainer entity under the "identity" entity type.
    const sourceBodies = {
        "/organizations": {
            organizations: [{ id: 7, name: "Acme Strength" }],
            users: [{ id: 3, role: "Trainer", first_name: "Dana", last_name: "Reed" }],
        },
    };

    it("settles success with final_counts keyed by entity type", async () => {
        const mock = await load();
        const r = routeRun(mock, { sourceBodies });
        await runLegacy(mock);
        expect(await settle(mock)).toBe("ingest_succeeded");
        expect(r.ingested.length).toBeGreaterThan(0);
        expect(r.completeBodies).toHaveLength(1);
        expect(r.completeBodies[0].terminal_status).toBe("success");
        const counts = r.completeBodies[0].final_counts;
        // Real entity-type keys, not the old {pages, entities} shape.
        expect(Object.keys(counts).length).toBeGreaterThan(0);
        expect(counts).not.toHaveProperty("pages");
        expect(counts).not.toHaveProperty("entities");
        for (const [key, value] of Object.entries(counts)) {
            expect(typeof key).toBe("string");
            expect(Number.isInteger(value)).toBe(true);
            expect(value).toBeGreaterThan(0);
        }
    });

    it("tallies exactly what the backend acked, summed per entity type", async () => {
        const mock = await load();
        const r = routeRun(mock, { sourceBodies });
        await runLegacy(mock);
        await settle(mock);
        const expected = new Map();
        for (const body of r.ingested) {
            const type = body.entity_type ?? body.entityType;
            const n = Array.isArray(body.entities) ? body.entities.length : 0;
            expected.set(type, (expected.get(type) ?? 0) + n);
        }
        for (const [type, n] of expected) {
            if (n > 0) {
                expect(r.completeBodies[0].final_counts[type]).toBe(n);
            }
        }
    });

    it("carries no error_summary when records did come across", async () => {
        const mock = await load();
        const r = routeRun(mock, { sourceBodies });
        await runLegacy(mock);
        await settle(mock);
        expect("error_summary" in r.completeBodies[0]).toBe(false);
    });
});

describe("legacy start_ingest — a rejected batch is never counted", () => {
    it("fails the run rather than settling a tally that includes an unacked batch", async () => {
        // makeSender throws on a non-2xx ingest, so the run leaves through the
        // catch path and settles `failed` — the tally must not have counted the
        // batch the backend refused.
        const mock = await load();
        const r = routeRun(mock, {
            sourceBodies: {
                "/organizations": {
                    organizations: [{ id: 7, name: "Acme Strength" }],
                    users: [{ id: 3, role: "Trainer", first_name: "Dana", last_name: "Reed" }],
                },
            },
            ingestStatus: () => 500,
        });
        await runLegacy(mock);
        expect(await settle(mock)).toBe("ingest_failed");
        expect(r.completeBodies).toHaveLength(1);
        expect(r.completeBodies[0].terminal_status).toBe("failed");
        // No tally is asserted on the failure path, so nothing is guessed.
        expect("final_counts" in r.completeBodies[0]).toBe(false);
    });
});
