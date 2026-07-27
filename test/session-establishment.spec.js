import { describe, it, expect, vi } from "vitest";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";

// Router-level coverage of the session-establishment boundary in background.js:
// the `session_established` / `request_session_state` handlers, the stricter
// token-bearing sender gate, and the guarantee that establishing a session
// never broadcasts or clobbers the ingest snapshot. Token-lifecycle mechanics
// (memory access token, storage.session refresh, mutex, no-wipe) are covered
// directly against shared/session.js in session-lifecycle.spec.js.
//
// Each test loads a FRESH module graph (resetModules) so background.js and its
// shared/session.js state start clean and the listeners bind to that test's
// mock.

const REFRESH_KEY = "tgp_refresh_token";
const SNAPSHOT_KEY = "tgp_status_snapshot";

async function load({ session } = {}) {
    vi.resetModules();
    const mock = makeBgMock({ session });
    installChrome(mock);
    global.fetch = vi.fn();
    const bg = await import("../background.js");
    return { mock, bg };
}

function statusBroadcasts(mock) {
    return mock.sent.filter((m) => m && m.kind === "status_snapshot");
}

const CONTENT_SCRIPT_SENDER = {
    id: "test-extension-id",
    url: "https://app.truecoach.co/clients",
    tab: { id: 42 },
};

describe("session_established — happy path", () => {
    it("persists refresh to storage.session and holds access in memory", async () => {
        const { mock, bg } = await load();
        const res = await mock.dispatch({
            kind: "session_established",
            accessToken: "access-1",
            refreshToken: "refresh-1",
        });
        expect(res).toEqual({ ok: true });
        expect(mock.sessionMap.get(REFRESH_KEY)).toBe("refresh-1");
        // Access token is usable immediately from memory — no refresh call.
        await expect(bg.getAccessToken()).resolves.toBe("access-1");
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("does NOT broadcast a snapshot or clobber an active ingest snapshot", async () => {
        // Seed an in-flight ingest snapshot in storage.local.
        const active = {
            kind: "status_snapshot",
            intent: { intentId: "ext-1", platform: "truecoach", status: "ingest_started" },
            progress: [{ entityType: "clients", sent: 3, total: 10 }],
            lastError: null,
        };
        const { mock } = await load();
        await mock.chrome.storage.local.set({ [SNAPSHOT_KEY]: active });

        await mock.dispatch({
            kind: "session_established",
            accessToken: "a",
            refreshToken: "r",
        });
        // Establishing a session emits no status broadcast at all …
        expect(statusBroadcasts(mock)).toEqual([]);
        // … and leaves the persisted ingest snapshot untouched.
        const stored = await mock.chrome.storage.local.get(SNAPSHOT_KEY);
        expect(stored[SNAPSHOT_KEY]).toEqual(active);
    });

    it("never writes a token to storage.local or storage.sync", async () => {
        const { mock } = await load();
        await mock.dispatch({
            kind: "session_established",
            accessToken: "a",
            refreshToken: "r",
        });
        expect(mock.localMap.has(REFRESH_KEY)).toBe(false);
        expect([...mock.localMap.values()]).not.toContain("r");
        expect([...mock.localMap.values()]).not.toContain("a");
        expect(mock.syncSet).toEqual([]);
    });
});

describe("session_established — malformed / missing tokens (fail-closed)", () => {
    const bad = [
        ["missing accessToken", { kind: "session_established", refreshToken: "r" }],
        ["missing refreshToken", { kind: "session_established", accessToken: "a" }],
        ["both missing", { kind: "session_established" }],
        ["empty accessToken", { kind: "session_established", accessToken: "", refreshToken: "r" }],
        ["empty refreshToken", { kind: "session_established", accessToken: "a", refreshToken: "" }],
        ["numeric accessToken", { kind: "session_established", accessToken: 7, refreshToken: "r" }],
        ["null refreshToken", { kind: "session_established", accessToken: "a", refreshToken: null }],
    ];

    for (const [name, message] of bad) {
        it(`rejects ${name} without persisting anything`, async () => {
            const { mock, bg } = await load();
            const res = await mock.dispatch(message);
            expect(res.ok).toBe(false);
            expect(res.error).toBe("invalid_token_payload");
            // No token material leaks into the error string.
            expect(res.error).not.toMatch(/access|refresh-|\br\b/);
            expect(mock.sessionMap.size).toBe(0);
            // Fail-closed: no session established.
            global.fetch.mockResolvedValue({ ok: false, status: 401 });
            await expect(bg.getAccessToken()).rejects.toThrow("no_session");
        });
    }

    it("a malformed message does not clobber an existing valid session", async () => {
        const { mock, bg } = await load();
        await mock.dispatch({
            kind: "session_established",
            accessToken: "keep-access",
            refreshToken: "keep-refresh",
        });
        const res = await mock.dispatch({ kind: "session_established", accessToken: "" });
        expect(res.ok).toBe(false);
        expect(mock.sessionMap.get(REFRESH_KEY)).toBe("keep-refresh");
        await expect(bg.getAccessToken()).resolves.toBe("keep-access");
    });
});

describe("session_established — duplicate / race handling", () => {
    it("a second establish overwrites the first (last write wins)", async () => {
        const { mock, bg } = await load();
        await mock.dispatch({ kind: "session_established", accessToken: "a1", refreshToken: "r1" });
        await mock.dispatch({ kind: "session_established", accessToken: "a2", refreshToken: "r2" });
        expect(mock.sessionMap.get(REFRESH_KEY)).toBe("r2");
        await expect(bg.getAccessToken()).resolves.toBe("a2");
    });
});

describe("request_session_state — non-secret routing signal", () => {
    it("reports hasSession=false with no session and never leaks a token", async () => {
        const { mock } = await load({ session: new Map() });
        const res = await mock.dispatch({ kind: "request_session_state" });
        expect(res).toEqual({ ok: true, hasSession: false });
    });

    it("reports hasSession=true once a refresh token is present", async () => {
        const { mock } = await load();
        await mock.dispatch({
            kind: "session_established",
            accessToken: "access-secret",
            refreshToken: "refresh-secret",
        });
        const res = await mock.dispatch({ kind: "request_session_state" });
        expect(res).toEqual({ ok: true, hasSession: true });
        // The response body carries only the boolean — no token material.
        expect(JSON.stringify(res)).not.toContain("secret");
        expect(Object.keys(res).sort()).toEqual(["hasSession", "ok"]);
    });
});

describe("service-worker restart — refresh survives, access is re-minted", () => {
    it("rehydrates the access token from the storage.session refresh token", async () => {
        const first = await load();
        await first.mock.dispatch({
            kind: "session_established",
            accessToken: "access-old",
            refreshToken: "refresh-live",
        });
        const survivingSession = new Map(first.mock.sessionMap);

        // Worker dies and wakes: session store survives, memory does not.
        const { mock, bg } = await load({ session: survivingSession });
        expect(mock.sessionMap.get(REFRESH_KEY)).toBe("refresh-live");
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ access_token: "access-new" }),
        });
        await expect(bg.getAccessToken()).resolves.toBe("access-new");
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe("https://api.tgp.coach/api/auth/extension/refresh");
        expect(JSON.parse(init.body)).toEqual({ refresh_token: "refresh-live" });
    });
});

describe("browser restart — storage.session cleared forces a re-pair", () => {
    it("has no refresh token to rehydrate and never calls the refresh endpoint", async () => {
        const { mock, bg } = await load({ session: new Map() });
        expect(mock.sessionMap.size).toBe(0);
        await expect(bg.getAccessToken()).rejects.toThrow("no_session");
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe("sender validation — only trusted extension pages may carry tokens", () => {
    it("ignores a session_established from a foreign extension id", async () => {
        const { mock, bg } = await load();
        const res = await mock.dispatch(
            { kind: "session_established", accessToken: "a", refreshToken: "r" },
            { id: "some-other-extension", url: "chrome-extension://some-other-extension/x.html" },
        );
        expect(res).toBeUndefined();
        expect(mock.sessionMap.size).toBe(0);
        global.fetch.mockResolvedValue({ ok: false, status: 401 });
        await expect(bg.getAccessToken()).rejects.toThrow("no_session");
    });

    it("rejects a session_established from a content script (our id, but a tab + web URL)", async () => {
        const { mock, bg } = await load();
        const res = await mock.dispatch(
            { kind: "session_established", accessToken: "a", refreshToken: "r" },
            CONTENT_SCRIPT_SENDER,
        );
        expect(res).toBeUndefined();
        expect(mock.sessionMap.size).toBe(0);
        global.fetch.mockResolvedValue({ ok: false, status: 401 });
        await expect(bg.getAccessToken()).rejects.toThrow("no_session");
    });

    it("ignores a message with a non-record sender", async () => {
        const { mock } = await load();
        const res = await mock.dispatch(
            { kind: "session_established", accessToken: "a", refreshToken: "r" },
            null,
        );
        expect(res).toBeUndefined();
        expect(mock.sessionMap.size).toBe(0);
    });
});
