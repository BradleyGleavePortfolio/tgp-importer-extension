import { describe, it, expect, vi } from "vitest";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";

// Router + orchestration coverage of the start_import path in background.js —
// the LIVE wiring that drives the site-agnostic replay engine. These tests pin
// the wiring-layer audit findings that are MANDATORY for PR-C1b:
//   - start_import is gated by the FULL trusted-extension-page shape, not an
//     extension-id match alone (a content script shares the id).
//   - a single-flight guard rejects a second concurrent run.
//   - the injected source fetch carries the SOURCE bearer so the crawl truly
//     authenticates (end-to-end, not a source grep).
//   - a source 401/403 fails closed via AuthLostError WITHOUT clearing the TGP
//     tokens (source auth loss != TGP logout).
//   - the pre-run guards (unsupported site, unsafe origin, no TGP session).

const REFRESH_KEY = "tgp_refresh_token";
const REFRESH_URL = "https://api.tgp.coach/auth/extension/refresh";
const INGEST_URL = "https://api.tgp.coach/api/scout/ingest";
const COMPLETE_URL = "https://api.tgp.coach/api/scout/ingest/complete";
const CLIENTS_PREFIX = "https://app.truecoach.co/proxy/api/clients?";
const NOTES_URL = "https://app.truecoach.co/proxy/api/clients/c1/notes";
const TAB_URL = "https://app.truecoach.co/clients";

async function load({ session } = {}) {
    vi.resetModules();
    const mock = makeBgMock({ session });
    installChrome(mock);
    global.fetch = vi.fn();
    const bg = await import("../background.js");
    return { mock, bg };
}

// A few macrotask turns so the async handler chain (getAccessToken + broadcasts)
// runs after dispatch returns its synchronous ack.
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
function authRequired(mock) {
    return mock.sent.filter((m) => m && m.kind === "auth_required");
}

// Poll until a terminal intent status is broadcast (the crawl paces requests
// with real 500ms sleeps, so a fixed flush is not enough for a full run).
async function settle(mock, ms = 10000) {
    const start = Date.now();
    for (;;) {
        const last = snapshots(mock).at(-1);
        const status = last && last.intent ? last.intent.status : null;
        if (status === "ingest_succeeded" || status === "ingest_failed") {
            return status;
        }
        if (Date.now() - start > ms) {
            return status;
        }
        await new Promise((r) => setTimeout(r, 20));
    }
}

describe("start_import — sender trust gate", () => {
    it("drops a message from a foreign extension id (no response, no work)", async () => {
        const { mock } = await load({ session: new Map([[REFRESH_KEY, "seed"]]) });
        const foreign = { id: "some-other-ext", url: "chrome-extension://some-other-ext/popup.html" };
        const ack = await mock.dispatch({ kind: "start_import", url: TAB_URL }, foreign);
        expect(ack).toBeUndefined();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("rejects a content-script-shaped sender (same id + a tab) as untrusted", async () => {
        const { mock } = await load({ session: new Map([[REFRESH_KEY, "seed"]]) });
        // Same extension id, but a web-page URL and an originating tab: exactly a
        // compromised content script. isTrustedExtensionPage must refuse it.
        const contentScript = { id: "test-extension-id", url: TAB_URL, tab: { id: 9 } };
        const ack = await mock.dispatch({ kind: "start_import", url: TAB_URL }, contentScript);
        expect(ack).toEqual({ ok: false, error: "untrusted_sender" });
        await flush();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe("start_import — single-flight guard", () => {
    it("rejects a second concurrent run while the first is in flight", async () => {
        const { mock } = await load({ session: new Map([[REFRESH_KEY, "seed"]]) });
        // Hang the first run on its refresh fetch so it stays in flight.
        global.fetch.mockImplementation(() => new Promise(() => {}));
        const ack1 = await mock.dispatch({ kind: "start_import", url: TAB_URL, sourceToken: "S" });
        const ack2 = await mock.dispatch({ kind: "start_import", url: TAB_URL, sourceToken: "S" });
        expect(ack1).toEqual({ ok: true });
        expect(ack2).toEqual({ ok: false, error: "import_in_progress" });
    });

    it("clears the guard after a run settles so a later run may start", async () => {
        const { mock } = await load({ session: new Map([[REFRESH_KEY, "seed"]]) });
        // First run fails fast on an unsupported site, releasing the guard.
        const ack1 = await mock.dispatch({ kind: "start_import", url: "https://example.com/x" });
        expect(ack1).toEqual({ ok: true });
        await flush();
        const ack2 = await mock.dispatch({ kind: "start_import", url: "https://example.org/y" });
        // Guard was released, so this is accepted (not import_in_progress).
        expect(ack2).toEqual({ ok: true });
    });
});

describe("start_import — pre-run guards", () => {
    it("rejects an unsupported site without touching the network", async () => {
        const { mock } = await load({ session: new Map([[REFRESH_KEY, "seed"]]) });
        const ack = await mock.dispatch({ kind: "start_import", url: "https://example.com/x" });
        expect(ack).toEqual({ ok: true });
        await flush();
        expect(snapshots(mock).at(-1).lastError).toContain("unsupported site");
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("rejects a non-https tab origin before resolving a blueprint", async () => {
        const { mock } = await load({ session: new Map([[REFRESH_KEY, "seed"]]) });
        const ack = await mock.dispatch({ kind: "start_import", url: "http://app.truecoach.co/clients" });
        expect(ack).toEqual({ ok: true });
        await flush();
        expect(snapshots(mock).at(-1).lastError).toContain("unsafe import origin");
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("broadcasts auth_required and starts no crawl with no TGP session", async () => {
        const { mock } = await load(); // no refresh token seeded
        const ack = await mock.dispatch({ kind: "start_import", url: TAB_URL });
        expect(ack).toEqual({ ok: true });
        await flush();
        expect(authRequired(mock)).toHaveLength(1);
        expect(snapshots(mock).at(-1).lastError).toBe("login required to import");
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe("start_import — end-to-end crawl carries the source bearer", () => {
    it("authenticates every source request, ingests, completes, and succeeds", async () => {
        const { mock } = await load({ session: new Map([[REFRESH_KEY, "seed-refresh"]]) });
        const sourceAuth = [];
        const ingestBodies = [];
        let completeCalls = 0;
        global.fetch.mockImplementation(async (url, init) => {
            if (url === REFRESH_URL) {
                return { ok: true, status: 200, json: async () => ({ access_token: "TGP-ACCESS" }) };
            }
            if (url.startsWith(CLIENTS_PREFIX) && url.includes("page=1")) {
                sourceAuth.push(init.headers.Authorization);
                return { ok: true, status: 200, json: async () => ({ clients: [{ id: "c1" }] }) };
            }
            if (url.startsWith(CLIENTS_PREFIX) && url.includes("page=2")) {
                sourceAuth.push(init.headers.Authorization);
                return { ok: true, status: 200, json: async () => ({ clients: [] }) };
            }
            if (url === NOTES_URL) {
                sourceAuth.push(init.headers.Authorization);
                return { ok: true, status: 200, json: async () => ({ notes: [{ id: "n1" }] }) };
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

        const ack = await mock.dispatch({ kind: "start_import", url: TAB_URL, sourceToken: "SRC-TOKEN" });
        expect(ack).toEqual({ ok: true });
        const terminal = await settle(mock);

        // Every source request carried the injected source bearer verbatim.
        expect(sourceAuth.length).toBeGreaterThan(0);
        expect(sourceAuth.every((h) => h === "Bearer SRC-TOKEN")).toBe(true);
        // Entities crossed the ingest boundary with the LOCKED envelope + snake
        // outer body, and the run completed + reported success.
        expect(ingestBodies.length).toBeGreaterThanOrEqual(1);
        const first = ingestBodies[0];
        expect(first).toHaveProperty("intent_id");
        expect(first).toHaveProperty("entity_type");
        expect(first.entities[0]).toHaveProperty("sourceId");
        expect(first.entities[0]).toHaveProperty("sourcePlatform", "truecoach");
        expect(completeCalls).toBe(1);
        expect(terminal).toBe("ingest_succeeded");
    }, 15000);

    it("confines the crawl to the observed tab origin (never an off-origin host)", async () => {
        const { mock } = await load({ session: new Map([[REFRESH_KEY, "seed-refresh"]]) });
        const hosts = new Set();
        global.fetch.mockImplementation(async (url) => {
            hosts.add(new URL(url).origin);
            if (url === REFRESH_URL) {
                return { ok: true, status: 200, json: async () => ({ access_token: "TGP-ACCESS" }) };
            }
            if (url.startsWith(CLIENTS_PREFIX)) {
                return { ok: true, status: 200, json: async () => ({ clients: [] }) };
            }
            if (url === COMPLETE_URL) {
                return { ok: true, status: 200 };
            }
            throw new Error(`unrouted fetch ${url}`);
        });
        const ack = await mock.dispatch({ kind: "start_import", url: TAB_URL, sourceToken: "S" });
        expect(ack).toEqual({ ok: true });
        await settle(mock);
        // Only the source origin + the TGP api origin were ever contacted.
        expect([...hosts].sort()).toEqual(["https://api.tgp.coach", "https://app.truecoach.co"]);
    }, 15000);
});

describe("start_import — source auth loss fails closed without a TGP logout", () => {
    it("maps a source 401 to a source-specific failure and keeps the TGP tokens", async () => {
        const { mock } = await load({ session: new Map([[REFRESH_KEY, "seed-refresh"]]) });
        global.fetch.mockImplementation(async (url) => {
            if (url === REFRESH_URL) {
                return { ok: true, status: 200, json: async () => ({ access_token: "TGP-ACCESS" }) };
            }
            if (url.startsWith(CLIENTS_PREFIX)) {
                return { ok: false, status: 401, json: async () => ({}) };
            }
            throw new Error(`unrouted fetch ${url}`);
        });
        const ack = await mock.dispatch({ kind: "start_import", url: TAB_URL, sourceToken: "SRC" });
        expect(ack).toEqual({ ok: true });
        const terminal = await settle(mock);
        expect(terminal).toBe("ingest_failed");
        expect(snapshots(mock).at(-1).lastError).toMatch(/source sign-in required/);
        // Source auth loss must NOT clear the TGP tokens: clearTokens() would have
        // removed the refresh token from chrome.storage.session — it is still here.
        expect(mock.sessionMap.has(REFRESH_KEY)).toBe(true);
        // And it is NOT a TGP re-pair, so no auth_required was broadcast.
        expect(authRequired(mock)).toHaveLength(0);
    }, 15000);

    it("maps a source 403 the same way (forbidden is also a source auth loss)", async () => {
        const { mock } = await load({ session: new Map([[REFRESH_KEY, "seed-refresh"]]) });
        global.fetch.mockImplementation(async (url) => {
            if (url === REFRESH_URL) {
                return { ok: true, status: 200, json: async () => ({ access_token: "TGP-ACCESS" }) };
            }
            if (url.startsWith(CLIENTS_PREFIX)) {
                return { ok: false, status: 403, json: async () => ({}) };
            }
            throw new Error(`unrouted fetch ${url}`);
        });
        const ack = await mock.dispatch({ kind: "start_import", url: TAB_URL, sourceToken: "SRC" });
        expect(ack).toEqual({ ok: true });
        const terminal = await settle(mock);
        expect(terminal).toBe("ingest_failed");
        expect(snapshots(mock).at(-1).lastError).toMatch(/source sign-in required/);
        // A 403 is an authorization failure, not a TGP logout: tokens survive and
        // no re-pair prompt is raised.
        expect(mock.sessionMap.has(REFRESH_KEY)).toBe(true);
        expect(authRequired(mock)).toHaveLength(0);
    }, 15000);
});

describe("start_import — a non-auth source error fails the run without a re-pair", () => {
    it("surfaces a source 500 as a generic ingest failure (NOT a sign-in prompt)", async () => {
        const { mock } = await load({ session: new Map([[REFRESH_KEY, "seed-refresh"]]) });
        global.fetch.mockImplementation(async (url) => {
            if (url === REFRESH_URL) {
                return { ok: true, status: 200, json: async () => ({ access_token: "TGP-ACCESS" }) };
            }
            if (url.startsWith(CLIENTS_PREFIX)) {
                return { ok: false, status: 500, json: async () => ({}) };
            }
            throw new Error(`unrouted fetch ${url}`);
        });
        const ack = await mock.dispatch({ kind: "start_import", url: TAB_URL, sourceToken: "SRC" });
        expect(ack).toEqual({ ok: true });
        const terminal = await settle(mock);
        expect(terminal).toBe("ingest_failed");
        // A 5xx is a server fault, not an auth loss: it must NOT be reported as a
        // sign-in requirement, and it must not raise a re-pair.
        const lastError = snapshots(mock).at(-1).lastError;
        expect(lastError).not.toMatch(/source sign-in required/);
        expect(lastError).toBeTruthy();
        expect(mock.sessionMap.has(REFRESH_KEY)).toBe(true);
        expect(authRequired(mock)).toHaveLength(0);
    }, 15000);
});

describe("start_import — an absent source token sends no Authorization header", () => {
    it("omits Authorization entirely when no sourceToken is provided", async () => {
        const { mock } = await load({ session: new Map([[REFRESH_KEY, "seed-refresh"]]) });
        const sourceHeaders = [];
        global.fetch.mockImplementation(async (url, init) => {
            if (url === REFRESH_URL) {
                return { ok: true, status: 200, json: async () => ({ access_token: "TGP-ACCESS" }) };
            }
            if (url.startsWith(CLIENTS_PREFIX)) {
                sourceHeaders.push(init.headers);
                return { ok: true, status: 200, json: async () => ({ clients: [] }) };
            }
            if (url === COMPLETE_URL) {
                return { ok: true, status: 200 };
            }
            throw new Error(`unrouted fetch ${url}`);
        });
        // No sourceToken key at all on the message.
        const ack = await mock.dispatch({ kind: "start_import", url: TAB_URL });
        expect(ack).toEqual({ ok: true });
        await settle(mock);
        // Every source request went out with NO Authorization header (an empty
        // bearer must never be forged as "Bearer ").
        expect(sourceHeaders.length).toBeGreaterThan(0);
        expect(sourceHeaders.every((h) => h.Authorization === undefined)).toBe(true);
    }, 15000);
});
