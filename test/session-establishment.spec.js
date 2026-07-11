import { describe, it, expect, vi } from "vitest";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";

// Exhaustive coverage of the one authoritative session-establishment boundary in
// background.js: the `session_established` / `logout` handlers, the memory-only
// access token, the storage.session-only refresh token, and the fail-closed +
// re-pair semantics. Each test loads a FRESH background.js module (resetModules)
// so module state (the in-memory access token) starts clean and the listeners
// bind to that test's mock.

const REFRESH_KEY = "tgp_refresh_token";
const REFRESH_ENDPOINT = "https://api.tgp.coach/auth/extension/refresh";

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
function authRequiredBroadcasts(mock) {
    return mock.sent.filter((m) => m && m.kind === "auth_required");
}

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

    it("broadcasts a clean status snapshot and no auth_required", async () => {
        const { mock } = await load();
        await mock.dispatch({
            kind: "session_established",
            accessToken: "a",
            refreshToken: "r",
        });
        const snaps = statusBroadcasts(mock);
        expect(snaps.length).toBe(1);
        expect(snaps[0].lastError).toBeNull();
        expect(snaps[0].intent).toBeNull();
        expect(authRequiredBroadcasts(mock)).toEqual([]);
    });

    it("never writes a token to storage.local or storage.sync", async () => {
        const { mock } = await load();
        await mock.dispatch({
            kind: "session_established",
            accessToken: "a",
            refreshToken: "r",
        });
        expect(mock.localMap.has(REFRESH_KEY)).toBe(false);
        // Nothing in local should equal the token material.
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
            expect(typeof res.error).toBe("string");
            // No token material leaks into the error string.
            expect(res.error).not.toMatch(/access|refresh-|\br\b/);
            expect(res.error).toBe("session_established: invalid token payload");
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

    it("concurrent establishes resolve coherently without corruption", async () => {
        const { mock, bg } = await load();
        const [r1, r2] = await Promise.all([
            mock.dispatch({ kind: "session_established", accessToken: "aX", refreshToken: "rX" }),
            mock.dispatch({ kind: "session_established", accessToken: "aY", refreshToken: "rY" }),
        ]);
        expect(r1).toEqual({ ok: true });
        expect(r2).toEqual({ ok: true });
        // The stored refresh and in-memory access are a matched pair from one
        // winner — never a mix (e.g. rX with aY).
        const refresh = mock.sessionMap.get(REFRESH_KEY);
        const access = await bg.getAccessToken();
        expect([["rX", "aX"], ["rY", "aY"]]).toContainEqual([refresh, access]);
    });
});

describe("logout — symmetric session exit", () => {
    it("clears the refresh token and broadcasts auth_required", async () => {
        const { mock, bg } = await load();
        await mock.dispatch({ kind: "session_established", accessToken: "a", refreshToken: "r" });
        const res = await mock.dispatch({ kind: "logout" });
        expect(res).toEqual({ ok: true });
        expect(mock.sessionMap.size).toBe(0);
        expect(authRequiredBroadcasts(mock).length).toBe(1);
        // No refresh token left → no session recoverable without a fetch.
        await expect(bg.getAccessToken()).rejects.toThrow("no_session");
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("logout with no active session is a harmless no-op", async () => {
        const { mock } = await load();
        const res = await mock.dispatch({ kind: "logout" });
        expect(res).toEqual({ ok: true });
        expect(mock.sessionMap.size).toBe(0);
        expect(authRequiredBroadcasts(mock).length).toBe(1);
    });
});

describe("service-worker restart — refresh survives, access is re-minted", () => {
    it("rehydrates the access token from the storage.session refresh token", async () => {
        // First worker: establish a session.
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
        expect(url).toBe(REFRESH_ENDPOINT);
        expect(JSON.parse(init.body)).toEqual({ refresh_token: "refresh-live" });
    });

    it("honours refresh-token rotation returned by the refresh call", async () => {
        const { mock, bg } = await load({ session: new Map([[REFRESH_KEY, "refresh-old"]]) });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ access_token: "access-new", refresh_token: "refresh-rotated" }),
        });
        await expect(bg.getAccessToken()).resolves.toBe("access-new");
        expect(mock.sessionMap.get(REFRESH_KEY)).toBe("refresh-rotated");
    });
});

describe("browser restart — storage.session cleared forces a re-pair", () => {
    it("has no refresh token to rehydrate and never calls the refresh endpoint", async () => {
        // A browser restart clears storage.session, so the fresh worker starts
        // with an empty session store.
        const { mock, bg } = await load({ session: new Map() });
        expect(mock.sessionMap.size).toBe(0);
        await expect(bg.getAccessToken()).rejects.toThrow("no_session");
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("a rejected refresh clears state and requires a re-pair", async () => {
        const { mock, bg } = await load({ session: new Map([[REFRESH_KEY, "stale-refresh"]]) });
        global.fetch.mockResolvedValue({ ok: false, status: 401 });
        await expect(bg.getAccessToken()).rejects.toThrow("no_session");
        // clearTokens is available for uninstall/logout cleanup; after a failed
        // refresh the coach must re-pair from the mobile app.
        await bg.clearTokens();
        expect(mock.sessionMap.size).toBe(0);
    });
});

describe("sender validation — only the extension's own surfaces are trusted", () => {
    it("ignores a message from a foreign sender id", async () => {
        const { mock, bg } = await load();
        const res = await mock.dispatch(
            { kind: "session_established", accessToken: "a", refreshToken: "r" },
            { id: "some-other-extension" },
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
