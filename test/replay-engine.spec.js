import { describe, it, expect, vi } from "vitest";
import {
    runReplay,
    AuthLostError,
    AbortError,
    isAuthLost,
    isAborted,
} from "../shared/replay/engine.js";

// Behavioral coverage of the SITE-AGNOSTIC bounded replay engine. Every side
// effect is injected, so these are pure unit tests: no chrome, no real network,
// no wall-clock. The mandated matrix (docs/DECISION_V03_AUTONOMOUS_CRAWL.md) is
// exercised here — cycles, duplicate pages, malformed JSON, timeout, abort
// mid-fetch, 401/auth loss, retry/idempotency, backpressure, budget exhaustion,
// pagination (page + cursor), fan-out, safe methods, and 100x-scale boundedness.

const API = "https://api.test";
const ORIGINS = [API]; // REQUIRED SSRF allowlist capability, threaded into runReplay

function bp(steps, extra = {}) {
    return { platform: "test", apiBase: API, rateLimitMs: 0, steps, ...extra };
}

// Collects every emitted entity so tests can assert exactly what crossed the
// ingest boundary — including the LOCKED envelope's provenance fields.
function makeCollector() {
    const emitted = [];
    const emit = async (entityType, batch) => {
        for (const e of batch) {
            emitted.push({ entityType, ...e });
        }
    };
    return { emitted, emit };
}

function timeoutError() {
    const e = new Error("fetch_timeout");
    e.name = "TimeoutError";
    return e;
}
function httpError(status) {
    const e = new Error(`http_${status}`);
    e.name = "HttpError";
    e.status = status;
    return e;
}
function malformedError() {
    const e = new Error("bad_json");
    e.name = "MalformedResponseError";
    return e;
}

// A default no-wait clock so pace() never actually delays a test.
const fastClock = { now: () => 0, sleep: () => Promise.resolve() };

// Common-case runner: injects the REQUIRED allowedOrigins + fast clock. Negative
// allowlist tests call runReplay directly (below) to omit the capability.
function run(opts) {
    return runReplay({ allowedOrigins: ORIGINS, ...fastClock, ...opts });
}

describe("runReplay — single un-paginated page", () => {
    it("fetches one page and emits its items with source ids", async () => {
        const fetchJson = vi.fn().mockResolvedValue({ clients: [{ id: 1 }, { id: 2 }] });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            { id: "clients", entityType: "client", template: "/clients", itemsPath: ["clients"], idField: "id" },
        ]);
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.status).toBe("complete");
        expect(result.pages).toBe(1);
        expect(result.entities).toBe(2);
        expect(result.truncated).toBe(false);
        expect(emitted.map((e) => e.sourceId)).toEqual(["1", "2"]);
        expect(fetchJson).toHaveBeenCalledTimes(1);
        expect(fetchJson).toHaveBeenCalledWith(`${API}/clients`, expect.objectContaining({ method: "GET" }));
    });
});

describe("runReplay — LOCKED _interface.js envelope", () => {
    it("stamps all four fields: sourceId, sourcePlatform, capturedAt, payload", async () => {
        const fetchJson = vi.fn().mockResolvedValue({ items: [{ id: 7, name: "z" }] });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            { id: "s", entityType: "thing", template: "/things", itemsPath: ["items"], idField: "id" },
        ]);
        // Deterministic clock -> deterministic capturedAt (proves it is stamped from now()).
        await run({ blueprint, fetchJson, emit, now: () => 1_600_000_000_000 });
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toEqual({
            entityType: "thing",
            sourceId: "7",
            sourcePlatform: "test", // == bp.platform
            capturedAt: new Date(1_600_000_000_000).toISOString(),
            payload: { id: 7, name: "z" },
        });
    });
});

describe("runReplay — safe method only", () => {
    it("issues the exact method the blueprint declares (HEAD)", async () => {
        const fetchJson = vi.fn().mockResolvedValue({ items: [] });
        const { emit } = makeCollector();
        const blueprint = bp([
            { id: "probe", entityType: "probe", template: "/probe", method: "HEAD", itemsPath: ["items"] },
        ]);
        await run({ blueprint, fetchJson, emit });
        expect(fetchJson).toHaveBeenCalledWith(`${API}/probe`, expect.objectContaining({ method: "HEAD" }));
    });
});

describe("runReplay — page pagination", () => {
    it("walks pages until an empty page ends the list", async () => {
        const pages = {
            1: { clients: [{ id: "a" }, { id: "b" }] },
            2: { clients: [{ id: "c" }] },
            3: { clients: [] },
        };
        const fetchJson = vi.fn(async (url) => {
            const page = new URL(url).searchParams.get("page");
            return pages[page];
        });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "clients",
                entityType: "client",
                template: "/clients",
                itemsPath: ["clients"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ]);
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.pages).toBe(3); // pages 1,2 have items, page 3 empty terminates
        expect(emitted.map((e) => e.sourceId)).toEqual(["a", "b", "c"]);
    });
});

describe("runReplay — cursor pagination", () => {
    it("advances via nextPath and stops when the cursor token is absent", async () => {
        const byCursor = {
            none: { items: [{ id: 1 }], meta: { next: "C1" } },
            C1: { items: [{ id: 2 }], meta: { next: "C2" } },
            C2: { items: [{ id: 3 }], meta: {} },
        };
        const fetchJson = vi.fn(async (url) => {
            const c = new URL(url).searchParams.get("cursor") ?? "none";
            return byCursor[c];
        });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "feed",
                entityType: "post",
                template: "/feed",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "cursor", param: "cursor", nextPath: ["meta", "next"] },
            },
        ]);
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.pages).toBe(3);
        expect(emitted.map((e) => e.sourceId)).toEqual(["1", "2", "3"]);
    });
});

describe("runReplay — cursor cycle guard", () => {
    it("stops when a cursor points back to an already-visited URL", async () => {
        // The server keeps handing back the SAME next cursor forever; the engine's
        // per-context visited-URL set must break the loop rather than crawl forever.
        const fetchJson = vi.fn(async () => ({ items: [{ id: "x" }], meta: { next: "STUCK" } }));
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "feed",
                entityType: "post",
                template: "/feed",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "cursor", param: "cursor", nextPath: ["meta", "next"] },
            },
        ]);
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.status).toBe("complete");
        // page 1 (no cursor) + page 2 (cursor=STUCK); page 3 URL repeats -> halt.
        expect(fetchJson).toHaveBeenCalledTimes(2);
        // Same id across both pages is emitted exactly once (idempotency).
        expect(emitted.map((e) => e.sourceId)).toEqual(["x"]);
    });
});

describe("runReplay — duplicate-item idempotency", () => {
    it("emits each (entityType, sourceId) once even across pages", async () => {
        const pages = {
            1: { items: [{ id: 1 }, { id: 2 }] },
            2: { items: [{ id: 2 }, { id: 3 }] }, // id 2 repeats
            3: { items: [] },
        };
        const fetchJson = vi.fn(async (url) => pages[new URL(url).searchParams.get("page")]);
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "s",
                entityType: "thing",
                template: "/things",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ]);
        await run({ blueprint, fetchJson, emit });
        expect(emitted.map((e) => e.sourceId)).toEqual(["1", "2", "3"]);
    });
});

describe("runReplay — fan-out over collected ids", () => {
    it("collects parent ids then issues one child request per id", async () => {
        const fetchJson = vi.fn(async (url) => {
            if (url === `${API}/clients?page=1`) return { clients: [{ id: "c1" }, { id: "c2" }] };
            if (url === `${API}/clients?page=2`) return { clients: [] };
            if (url === `${API}/clients/c1/workouts?page=1`) return { workouts: [{ id: "w1" }] };
            if (url === `${API}/clients/c1/workouts?page=2`) return { workouts: [] };
            if (url === `${API}/clients/c2/workouts?page=1`) return { workouts: [{ id: "w2" }] };
            if (url === `${API}/clients/c2/workouts?page=2`) return { workouts: [] };
            throw new Error(`unexpected url ${url}`);
        });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "clients",
                entityType: "client",
                template: "/clients",
                itemsPath: ["clients"],
                idField: "id",
                collectAs: "clientIds",
                pagination: { style: "page", param: "page", start: 1 },
            },
            {
                id: "workouts",
                entityType: "workout",
                template: "/clients/:id/workouts",
                forEach: "clientIds",
                itemsPath: ["workouts"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ]);
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.status).toBe("complete");
        const workouts = emitted.filter((e) => e.entityType === "workout").map((e) => e.sourceId);
        expect(workouts).toEqual(["w1", "w2"]);
    });
});

describe("runReplay — malformed JSON", () => {
    it("skips a shape-shifted page without throwing or retrying", async () => {
        const fetchJson = vi.fn(async (url) => {
            if (new URL(url).searchParams.get("page") === "1") throw malformedError();
            return { items: [] };
        });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "s",
                entityType: "thing",
                template: "/things",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ]);
        const result = await run({ blueprint, fetchJson, emit });
        // A malformed page is SKIPPED (degraded), not silently "end of list": with
        // nothing ever emitted the run is honestly failed, never ordinary complete.
        expect(result.status).toBe("failed");
        expect(result.degraded).toBe(true);
        expect(fetchJson).toHaveBeenCalledTimes(1); // skipped without retry
        expect(emitted).toHaveLength(0);
    });
});

describe("runReplay — timeout with bounded retry", () => {
    it("retries a timing-out page up to maxAttempts then skips it", async () => {
        const fetchJson = vi.fn(async () => { throw timeoutError(); });
        const { emit } = makeCollector();
        const blueprint = bp([
            { id: "s", entityType: "thing", template: "/things", itemsPath: ["items"], idField: "id" },
        ]);
        const result = await run({ blueprint, fetchJson, emit, maxAttempts: 3 });
        // Retries exhausted -> page skipped (degraded); nothing emitted -> failed.
        expect(result.status).toBe("failed");
        expect(result.degraded).toBe(true);
        expect(fetchJson).toHaveBeenCalledTimes(3); // exactly maxAttempts, then give up
    });
});

describe("runReplay — transient retry then success", () => {
    it("recovers when a 5xx is followed by a good response", async () => {
        let call = 0;
        const fetchJson = vi.fn(async () => {
            call += 1;
            if (call === 1) throw httpError(503);
            return { items: [{ id: "ok" }] };
        });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            { id: "s", entityType: "thing", template: "/things", itemsPath: ["items"], idField: "id" },
        ]);
        const result = await run({ blueprint, fetchJson, emit, maxAttempts: 3 });
        expect(result.status).toBe("complete");
        expect(fetchJson).toHaveBeenCalledTimes(2);
        expect(emitted.map((e) => e.sourceId)).toEqual(["ok"]);
    });

    it("does not retry a non-auth 4xx (it is not transient)", async () => {
        const fetchJson = vi.fn(async () => { throw httpError(404); });
        const { emit } = makeCollector();
        const blueprint = bp([
            { id: "s", entityType: "thing", template: "/things", itemsPath: ["items"], idField: "id" },
        ]);
        const result = await run({ blueprint, fetchJson, emit, maxAttempts: 3 });
        // Non-retryable 4xx -> page skipped (degraded); nothing emitted -> failed.
        expect(result.status).toBe("failed");
        expect(result.degraded).toBe(true);
        expect(fetchJson).toHaveBeenCalledTimes(1); // 404 skipped immediately
    });
});

describe("runReplay — auth loss fails closed", () => {
    it("propagates AuthLostError and makes no further requests", async () => {
        let calls = 0;
        const fetchJson = vi.fn(async () => { calls += 1; throw new AuthLostError(); });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "s",
                entityType: "thing",
                template: "/things",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ]);
        await expect(run({ blueprint, fetchJson, emit })).rejects.toSatisfy(isAuthLost);
        expect(calls).toBe(1); // stopped on first auth loss, no retry, no next page
        expect(emitted).toHaveLength(0);
    });
});

describe("runReplay — abort", () => {
    it("returns cancelled when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchJson = vi.fn();
        const { emit } = makeCollector();
        const blueprint = bp([
            { id: "s", entityType: "thing", template: "/things", itemsPath: ["items"], idField: "id" },
        ]);
        const result = await run({ blueprint, fetchJson, emit, signal: controller.signal });
        expect(result.status).toBe("cancelled");
        expect(fetchJson).not.toHaveBeenCalled();
    });

    it("stops promptly when aborted mid-run (during emit)", async () => {
        const controller = new AbortController();
        const pages = {
            1: { items: [{ id: 1 }] },
            2: { items: [{ id: 2 }] },
        };
        const fetchJson = vi.fn(async (url) => pages[new URL(url).searchParams.get("page")]);
        // Abort as soon as the first batch is handed off; the next loop turn sees it.
        const emit = vi.fn(async () => { controller.abort(); });
        const blueprint = bp([
            {
                id: "s",
                entityType: "thing",
                template: "/things",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ]);
        const result = await run({ blueprint, fetchJson, emit, signal: controller.signal });
        expect(result.status).toBe("cancelled");
        expect(fetchJson).toHaveBeenCalledTimes(1); // did not fetch page 2
    });
});

describe("runReplay — backpressure", () => {
    it("awaits emit before fetching the next page (no unbounded buffering)", async () => {
        const order = [];
        const pages = {
            1: { items: [{ id: 1 }] },
            2: { items: [{ id: 2 }] },
            3: { items: [] },
        };
        const fetchJson = vi.fn(async (url) => {
            order.push(`fetch:${new URL(url).searchParams.get("page")}`);
            return pages[new URL(url).searchParams.get("page")];
        });
        const emit = vi.fn(async (_type, batch) => {
            order.push(`emit:${batch[0].sourceId}`);
        });
        const blueprint = bp([
            {
                id: "s",
                entityType: "thing",
                template: "/things",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ]);
        await run({ blueprint, fetchJson, emit });
        expect(order).toEqual(["fetch:1", "emit:1", "fetch:2", "emit:2", "fetch:3"]);
    });
});

describe("runReplay — budget exhaustion", () => {
    it("stops and marks truncated when maxEntities is reached", async () => {
        // Endless list of unique ids; the entity budget must terminate the walk.
        const fetchJson = vi.fn(async (url) => {
            const page = Number(new URL(url).searchParams.get("page"));
            return { items: Array.from({ length: 10 }, (_v, i) => ({ id: `${page}-${i}` })) };
        });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "s",
                entityType: "thing",
                template: "/things",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ], { budgets: { maxEntities: 25 } });
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.truncated).toBe(true);
        // Never runs unbounded: emitted count stays within a couple of batches of cap.
        expect(emitted.length).toBeGreaterThanOrEqual(25);
        expect(emitted.length).toBeLessThan(40);
    });

    it("stops and marks truncated when maxPages is reached", async () => {
        const fetchJson = vi.fn(async () => ({ items: [{ id: Math.random() }] }));
        const { emit } = makeCollector();
        const blueprint = bp([
            {
                id: "s",
                entityType: "thing",
                template: "/things",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ], { budgets: { maxPages: 5 } });
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.truncated).toBe(true);
        expect(result.pages).toBe(5);
    });

    it("stops a single step at maxPagesPerStep", async () => {
        const fetchJson = vi.fn(async () => ({ items: [{ id: Math.random() }] }));
        const { emit } = makeCollector();
        const blueprint = bp([
            {
                id: "s",
                entityType: "thing",
                template: "/things",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ], { budgets: { maxPagesPerStep: 3, maxPages: 1000 } });
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.truncated).toBe(true);
        expect(fetchJson).toHaveBeenCalledTimes(3);
    });

    it("enforces maxPagesPerStep as a TRUE per-step aggregate across fan-out contexts", async () => {
        // 3 parents, child step paginates endlessly. maxPagesPerStep=4 must cap the
        // ENTIRE child step at 4 pages total (not 4 per parent = 12).
        const fetchJson = vi.fn(async (url) => {
            if (url === `${API}/parents?page=1`) return { items: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] };
            if (url === `${API}/parents?page=2`) return { items: [] };
            // every child page is non-empty forever
            return { items: [{ id: Math.random() }] };
        });
        const { emit } = makeCollector();
        const blueprint = bp([
            {
                id: "parents",
                entityType: "parent",
                template: "/parents",
                itemsPath: ["items"],
                idField: "id",
                collectAs: "pids",
                pagination: { style: "page", param: "page", start: 1 },
            },
            {
                id: "kids",
                entityType: "kid",
                template: "/parents/:id/kids",
                forEach: "pids",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ], { budgets: { maxPagesPerStep: 4, maxPages: 1000 } });
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.truncated).toBe(true);
        // 2 parent pages + 4 kid pages (aggregate cap), never 12.
        const kidCalls = fetchJson.mock.calls.filter(([u]) => u.includes("/kids")).length;
        expect(kidCalls).toBe(4);
    });
});

describe("runReplay — 100x-scale boundedness", () => {
    it("terminates in finite work on a would-be-infinite source", async () => {
        // 100 items per page, unique ids, list never ends. Must still halt.
        const fetchJson = vi.fn(async (url) => {
            const page = Number(new URL(url).searchParams.get("page"));
            return { items: Array.from({ length: 100 }, (_v, i) => ({ id: `${page}:${i}` })) };
        });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "s",
                entityType: "thing",
                template: "/things",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ], { budgets: { maxPages: 50, maxPagesPerStep: 50, maxEntities: 100000 } });
        const result = await run({ blueprint, fetchJson, emit });
        // Budget-truncated: emitted plenty but did NOT reach the end of the list, so
        // the honest terminal status is partial (not complete). No page was skipped.
        expect(result.status).toBe("partial");
        expect(result.truncated).toBe(true);
        expect(result.degraded).toBe(false);
        expect(result.pages).toBeLessThanOrEqual(50);
        expect(emitted.length).toBeLessThanOrEqual(50 * 100);
    });
});

describe("runReplay — progress + rate limiting", () => {
    it("reports monotonic per-step progress (sent only; total is unknowable)", async () => {
        const pages = { 1: { items: [{ id: 1 }, { id: 2 }] }, 2: { items: [] } };
        const fetchJson = vi.fn(async (url) => pages[new URL(url).searchParams.get("page")]);
        const { emit } = makeCollector();
        const snapshots = [];
        const blueprint = bp([
            {
                id: "s",
                entityType: "thing",
                template: "/things",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ]);
        await run({ blueprint, fetchJson, emit, onProgress: (p) => snapshots.push(p) });
        const last = snapshots.at(-1)[0];
        expect(last.entityType).toBe("thing");
        expect(last.sent).toBe(2);
        // No tautological `total` field is reported — a crawl's total is unknown up front.
        expect(last).not.toHaveProperty("total");
    });

    it("paces requests using injected now/sleep when rateLimitMs > 0", async () => {
        const sleeps = [];
        let clock = 0;
        const fetchJson = vi.fn(async (url) => {
            const page = new URL(url).searchParams.get("page");
            return page === "1" ? { items: [{ id: 1 }] } : { items: [] };
        });
        const { emit } = makeCollector();
        const blueprint = bp([
            {
                id: "s",
                entityType: "thing",
                template: "/things",
                itemsPath: ["items"],
                idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ], { rateLimitMs: 500 });
        await run({
            blueprint,
            fetchJson,
            emit,
            now: () => clock,
            sleep: (ms) => { sleeps.push(ms); clock += ms; return Promise.resolve(); },
        });
        // Second request must wait ~the full interval since the clock did not advance.
        expect(sleeps.some((ms) => ms > 0)).toBe(true);
    });
});

describe("engine error predicates", () => {
    it("isAuthLost / isAborted only match their own error types", () => {
        expect(isAuthLost(new AuthLostError())).toBe(true);
        expect(isAuthLost(new AbortError())).toBe(false);
        expect(isAborted(new AbortError())).toBe(true);
        expect(isAborted(new Error("nope"))).toBe(false);
    });
});

// The idempotency key is a JSON tuple, not a space-joined string. A string join
// collides across a field boundary — the tuple keeps distinct identities distinct.
describe("runReplay — dedupe key resists delimiter collision", () => {
    it("emits two entities whose old space-joined keys would have collided", async () => {
        const fetchJson = vi.fn(async (url) => {
            if (url.endsWith("/x")) return { items: [{ id: "c" }] };
            return { items: [{ id: "b c" }] };
        });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            { id: "s1", entityType: "a b", template: "/x", itemsPath: ["items"], idField: "id" },
            { id: "s2", entityType: "a", template: "/y", itemsPath: ["items"], idField: "id" },
        ]);
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.status).toBe("complete");
        expect(emitted).toEqual([
            expect.objectContaining({ entityType: "a b", sourceId: "c" }),
            expect.objectContaining({ entityType: "a", sourceId: "b c" }),
        ]);
    });

    it("still dedupes a genuine repeat of the same (step, context, sourceId)", async () => {
        const pages = {
            1: { items: [{ id: "dup" }] },
            2: { items: [{ id: "dup" }] },
            3: { items: [] },
        };
        const fetchJson = vi.fn(async (url) => pages[new URL(url).searchParams.get("page")]);
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "s", entityType: "thing", template: "/things", itemsPath: ["items"],
                idField: "id", pagination: { style: "page", param: "page", start: 1 },
            },
        ]);
        await run({ blueprint, fetchJson, emit });
        expect(emitted.map((e) => e.sourceId)).toEqual(["dup"]);
    });
});

// P2-1 (Lens A): a run-global visited set dropped a whole step that legitimately
// re-hit the same endpoint URL, and reported complete. visited is now per-context.
describe("runReplay — two steps sharing an endpoint URL both execute", () => {
    it("does not let one step's fetch suppress another step's same-URL fetch", async () => {
        const fetchJson = vi.fn(async () => ({ clients: [{ id: "c1" }], programs: [{ id: "p1" }, { id: "p2" }] }));
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            { id: "clients", entityType: "client", template: "/dashboard", itemsPath: ["clients"], idField: "id" },
            { id: "programs", entityType: "program", template: "/dashboard", itemsPath: ["programs"], idField: "id" },
        ]);
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.status).toBe("complete");
        expect(fetchJson).toHaveBeenCalledTimes(2); // /dashboard fetched once per step
        expect(emitted.filter((e) => e.entityType === "client").map((e) => e.sourceId)).toEqual(["c1"]);
        expect(emitted.filter((e) => e.entityType === "program").map((e) => e.sourceId)).toEqual(["p1", "p2"]);
    });
});

// P3-1 (Lens A): a forEach step with a STATIC template built the identical URL
// for every parent; a run-global visited set let only the first through. Now each
// parent context has its own visited, so every parent is fetched.
describe("runReplay — static-template fan-out emits for every parent context", () => {
    it("fetches the static child endpoint once per parent id", async () => {
        const fetchJson = vi.fn(async (url) => {
            if (url === `${API}/parents?page=1`) return { items: [{ id: "a" }, { id: "b" }, { id: "c" }] };
            if (url === `${API}/parents?page=2`) return { items: [] };
            if (url === `${API}/all-kids`) return { kids: [{ id: `k-${Math.random()}` }] };
            throw new Error(`unexpected ${url}`);
        });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "parents", entityType: "parent", template: "/parents", itemsPath: ["items"],
                idField: "id", collectAs: "pids", pagination: { style: "page", param: "page", start: 1 },
            },
            // static template + forEach: each parent context hits the SAME URL.
            { id: "kids", entityType: "kid", template: "/all-kids", forEach: "pids", itemsPath: ["kids"], idField: "id" },
        ]);
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.status).toBe("complete");
        const kidCalls = fetchJson.mock.calls.filter(([u]) => u === `${API}/all-kids`).length;
        expect(kidCalls).toBe(3); // once per parent, not once total
        expect(emitted.filter((e) => e.entityType === "kid")).toHaveLength(3);
    });
});

// P2-1 (Lens B): parent-scoped child ids that collide across parents must both be
// emitted (the dedupe key now carries the fan-out context), while a same-context
// repeat still dedupes.
describe("runReplay — context-scoped dedupe keeps parent-scoped child ids distinct", () => {
    it("emits child id '1' under BOTH parents but dedupes a repeat within one parent", async () => {
        const fetchJson = vi.fn(async (url) => {
            if (url === `${API}/clients?page=1`) return { clients: [{ id: "A" }, { id: "B" }] };
            if (url === `${API}/clients?page=2`) return { clients: [] };
            if (url === `${API}/clients/A/w?page=1`) return { w: [{ id: "1" }, { id: "1" }] }; // repeat within A
            if (url === `${API}/clients/A/w?page=2`) return { w: [] };
            if (url === `${API}/clients/B/w?page=1`) return { w: [{ id: "1" }] }; // same id, different parent
            if (url === `${API}/clients/B/w?page=2`) return { w: [] };
            throw new Error(`unexpected ${url}`);
        });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "clients", entityType: "client", template: "/clients", itemsPath: ["clients"],
                idField: "id", collectAs: "cids", pagination: { style: "page", param: "page", start: 1 },
            },
            {
                id: "w", entityType: "workout", template: "/clients/:id/w", forEach: "cids",
                itemsPath: ["w"], idField: "id", pagination: { style: "page", param: "page", start: 1 },
            },
        ]);
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.status).toBe("complete");
        const workouts = emitted.filter((e) => e.entityType === "workout");
        // id "1" survives under A and under B (2 entities), repeat within A deduped.
        expect(workouts).toHaveLength(2);
        expect(workouts.every((e) => e.sourceId === "1")).toBe(true);
    });
});

// P3-2 (Lens A): the REQUIRED allowedOrigins SSRF capability must be threaded into
// normalization; a missing/empty/off-allowlist origin fails closed BEFORE any fetch.
describe("runReplay — allowedOrigins capability is enforced before any fetch", () => {
    it("rejects when allowedOrigins is absent, making no request", async () => {
        const fetchJson = vi.fn();
        const { emit } = makeCollector();
        const blueprint = bp([
            { id: "s", entityType: "thing", template: "/things", itemsPath: ["items"], idField: "id" },
        ]);
        await expect(runReplay({ blueprint, fetchJson, emit, ...fastClock })).rejects.toThrow(/allowedOrigins/);
        expect(fetchJson).not.toHaveBeenCalled();
    });

    it("rejects when allowedOrigins is empty, making no request", async () => {
        const fetchJson = vi.fn();
        const { emit } = makeCollector();
        const blueprint = bp([
            { id: "s", entityType: "thing", template: "/things", itemsPath: ["items"], idField: "id" },
        ]);
        await expect(runReplay({ blueprint, fetchJson, emit, allowedOrigins: [], ...fastClock }))
            .rejects.toThrow(/allowedOrigins/);
        expect(fetchJson).not.toHaveBeenCalled();
    });

    it("rejects when the apiBase origin is not on the allowlist, making no request", async () => {
        const fetchJson = vi.fn();
        const { emit } = makeCollector();
        const blueprint = bp([
            { id: "s", entityType: "thing", template: "/things", itemsPath: ["items"], idField: "id" },
        ]);
        await expect(runReplay({
            blueprint, fetchJson, emit, allowedOrigins: ["https://not-the-api.example.com"], ...fastClock,
        })).rejects.toThrow(/allowed-origins/);
        expect(fetchJson).not.toHaveBeenCalled();
    });
});

// P3-3 (Lens A): a self-referential collectAs === forEach blueprint is rejected at
// normalization, so runReplay fails closed before any fetch.
describe("runReplay — self-referential collectAs === forEach is rejected", () => {
    it("throws at normalization and makes no request", async () => {
        const fetchJson = vi.fn();
        const { emit } = makeCollector();
        const blueprint = bp([
            { id: "seed", entityType: "seed", template: "/seed", itemsPath: ["items"], idField: "id", collectAs: "loop" },
            {
                id: "loop", entityType: "node", template: "/nodes/:id", forEach: "loop",
                collectAs: "loop", itemsPath: ["items"], idField: "id",
            },
        ]);
        await expect(run({ blueprint, fetchJson, emit })).rejects.toThrow(/must not equal its own forEach/);
        expect(fetchJson).not.toHaveBeenCalled();
    });
});

// P3-2 (Lens B): a synthesized sourceId (id-less item) must NOT embed the request
// URL / cursor token — it is a bounded, deterministic, URL-free key.
describe("runReplay — synthetic sourceId does not leak the request URL / cursor", () => {
    it("derives an opaque bounded key with no query token for id-less items", async () => {
        const fetchJson = vi.fn(async (url) => {
            const c = new URL(url).searchParams.get("cursor") ?? "none";
            if (c === "none") return { items: [{ name: "anon" }], meta: { next: "SECRET-CURSOR-TOKEN" } };
            return { items: [], meta: {} };
        });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "feed", entityType: "post", template: "/feed", itemsPath: ["items"], idField: "id",
                pagination: { style: "cursor", param: "cursor", nextPath: ["meta", "next"] },
            },
        ]);
        await run({ blueprint, fetchJson, emit });
        expect(emitted).toHaveLength(1);
        const sid = emitted[0].sourceId;
        expect(sid).not.toContain("SECRET-CURSOR-TOKEN");
        expect(sid).not.toContain("://");
        expect(sid).not.toContain("?");
        expect(sid).toBe("feed#_#0#0"); // step # context # page # index
    });
});

// Honest terminal status matrix: complete only for a whole untruncated walk;
// partial when data was emitted but the walk was truncated or a page was skipped;
// failed when pages were skipped and nothing was ever emitted. (docs finding P2-1)
describe("runReplay — honest terminal status", () => {
    it("returns complete + degraded:false for a clean finite walk", async () => {
        const fetchJson = vi.fn().mockResolvedValue({ items: [{ id: 1 }] });
        const { emit } = makeCollector();
        const blueprint = bp([
            { id: "s", entityType: "t", template: "/t", itemsPath: ["items"], idField: "id" },
        ]);
        const result = await run({ blueprint, fetchJson, emit });
        expect(result).toMatchObject({ status: "complete", truncated: false, degraded: false });
    });

    it("returns partial when a mid-walk page is skipped but earlier data emitted", async () => {
        const pages = {
            1: { items: [{ id: "ok" }] },
            2: null, // sentinel -> throw malformed below
        };
        const fetchJson = vi.fn(async (url) => {
            const page = new URL(url).searchParams.get("page");
            if (pages[page] === null) throw malformedError();
            return pages[page] ?? { items: [] };
        });
        const { emitted, emit } = makeCollector();
        const blueprint = bp([
            {
                id: "s", entityType: "t", template: "/t", itemsPath: ["items"],
                idField: "id", pagination: { style: "page", param: "page", start: 1 },
            },
        ]);
        const result = await run({ blueprint, fetchJson, emit });
        expect(result.status).toBe("partial");
        expect(result.degraded).toBe(true);
        expect(emitted.map((e) => e.sourceId)).toEqual(["ok"]);
    });
});
