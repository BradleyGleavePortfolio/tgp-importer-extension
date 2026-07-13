import { describe, it, expect, vi, beforeEach } from "vitest";

// Direct unit coverage of shared/session.js — the single session/token
// ownership boundary. Exercised without background.js so the mutex, the
// no-asymmetric-wipe guarantee, refresh rotation, and hasActiveSession are
// pinned at the source. A fresh module import per test resets the module-level
// access token + mutex chain.

const REFRESH_KEY = "tgp_refresh_token";
const REFRESH_ENDPOINT = "https://api.tgp.coach/auth/extension/refresh";

// Minimal chrome.storage.session stub over a Map. `failSetOnce` makes the next
// set() reject WITHOUT mutating the map, to model a persist failure.
function installChromeStub({ session } = {}) {
    const map = new Map(session ?? []);
    const state = { failSetOnce: false };
    globalThis.chrome = {
        storage: {
            session: {
                get: async (key) => (map.has(key) ? { [key]: map.get(key) } : {}),
                set: async (obj) => {
                    if (state.failSetOnce) {
                        state.failSetOnce = false;
                        throw new Error("quota exceeded");
                    }
                    for (const [k, v] of Object.entries(obj)) map.set(k, v);
                },
                remove: async (key) => { map.delete(key); },
            },
        },
    };
    return { map, state };
}

async function load(opts) {
    vi.resetModules();
    const store = installChromeStub(opts);
    global.fetch = vi.fn();
    const mod = await import("../shared/session.js");
    return { ...store, mod };
}

beforeEach(() => {
    vi.restoreAllMocks();
});

describe("establishSession", () => {
    it("persists the refresh token and serves the access token from memory", async () => {
        const { map, mod } = await load();
        const res = await mod.establishSession("access-1", "refresh-1");
        expect(res).toEqual({ ok: true });
        expect(map.get(REFRESH_KEY)).toBe("refresh-1");
        await expect(mod.getAccessToken()).resolves.toBe("access-1");
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("rejects malformed input without touching storage or a prior session", async () => {
        const { map, mod } = await load();
        await mod.establishSession("keep-a", "keep-r");
        for (const bad of [["", "r"], ["a", ""], [7, "r"], ["a", null], [undefined, undefined]]) {
            const res = await mod.establishSession(bad[0], bad[1]);
            expect(res).toEqual({ ok: false, error: "invalid_token_payload" });
        }
        // The prior valid session is intact.
        expect(map.get(REFRESH_KEY)).toBe("keep-r");
        await expect(mod.getAccessToken()).resolves.toBe("keep-a");
    });

    it("a persist FAILURE never wipes an existing valid session (no asymmetric wipe)", async () => {
        const { map, state, mod } = await load();
        await mod.establishSession("access-old", "refresh-old");
        // Next persist rejects; the new establish must fail-closed and leave the
        // prior session fully usable.
        state.failSetOnce = true;
        const res = await mod.establishSession("access-new", "refresh-new");
        expect(res).toEqual({ ok: false, error: "session_persist_failed" });
        expect(map.get(REFRESH_KEY)).toBe("refresh-old");
        await expect(mod.getAccessToken()).resolves.toBe("access-old");
    });
});

describe("clearTokens + hasActiveSession", () => {
    it("clears memory + storage and reports no active session", async () => {
        const { map, mod } = await load();
        await mod.establishSession("a", "r");
        expect(await mod.hasActiveSession()).toBe(true);
        await mod.clearTokens();
        expect(map.has(REFRESH_KEY)).toBe(false);
        expect(await mod.hasActiveSession()).toBe(false);
    });

    it("hasActiveSession is true from a surviving refresh token alone (cold wake)", async () => {
        const { mod } = await load({ session: new Map([[REFRESH_KEY, "refresh-live"]]) });
        expect(await mod.hasActiveSession()).toBe(true);
    });
});

describe("getAccessToken / refresh rotation", () => {
    it("mints a new access token from the refresh token on a cold wake", async () => {
        const { mod } = await load({ session: new Map([[REFRESH_KEY, "refresh-live"]]) });
        global.fetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: "minted" }) });
        await expect(mod.getAccessToken()).resolves.toBe("minted");
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe(REFRESH_ENDPOINT);
        expect(JSON.parse(init.body)).toEqual({ refresh_token: "refresh-live" });
    });

    it("honours a rotated refresh token returned by the refresh call", async () => {
        const { map, mod } = await load({ session: new Map([[REFRESH_KEY, "refresh-old"]]) });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ access_token: "minted", refresh_token: "refresh-rotated" }),
        });
        await expect(mod.getAccessToken()).resolves.toBe("minted");
        expect(map.get(REFRESH_KEY)).toBe("refresh-rotated");
    });

    it("throws no_session when the refresh call is rejected", async () => {
        const { mod } = await load({ session: new Map([[REFRESH_KEY, "stale"]]) });
        global.fetch.mockResolvedValue({ ok: false, status: 401 });
        await expect(mod.getAccessToken()).rejects.toThrow("no_session");
    });
});

describe("serialized state transitions (mutex)", () => {
    it("a genuinely concurrent establish + clear resolves to a coherent state", async () => {
        const { map, mod } = await load();
        // Fire both without awaiting between them so they contend for the lock.
        const [establishRes, clearRes] = await Promise.all([
            mod.establishSession("aX", "rX"),
            mod.clearTokens(),
        ]);
        expect(establishRes).toEqual({ ok: true });
        expect(clearRes).toBeUndefined();
        // Invariant: access presence iff refresh presence — never a torn pair.
        const refreshPresent = map.has(REFRESH_KEY);
        if (refreshPresent) {
            await expect(mod.getAccessToken()).resolves.toBe("aX");
        }
        else {
            global.fetch.mockResolvedValue({ ok: false, status: 401 });
            await expect(mod.getAccessToken()).rejects.toThrow("no_session");
        }
    });

    it("concurrent establishes never produce a mixed access/refresh pair", async () => {
        const { map, mod } = await load();
        const [r1, r2] = await Promise.all([
            mod.establishSession("aX", "rX"),
            mod.establishSession("aY", "rY"),
        ]);
        expect(r1).toEqual({ ok: true });
        expect(r2).toEqual({ ok: true });
        const refresh = map.get(REFRESH_KEY);
        const access = await mod.getAccessToken();
        expect([["rX", "aX"], ["rY", "aY"]]).toContainEqual([refresh, access]);
    });
});

// A mutation-sensitive suite: a logout that lands WHILE a refresh is on the
// network must not be undone by the refresh committing afterwards. This is the
// stale-refresh resurrection hole; the epoch compare-and-swap closes it.
describe("refresh serialization vs logout (no stale resurrection)", () => {
    // Drive a refresh whose network call is held open, run clearTokens() in the
    // gap, then release the network — the refresh must discard its result.
    it("a logout during an in-flight refresh is NOT resurrected", async () => {
        const { map, mod } = await load({ session: new Map([[REFRESH_KEY, "refresh-live"]]) });
        // Warm the in-memory access token so we control exactly one refresh.
        await mod.establishSession("access-1", "refresh-live");

        let releaseFetch;
        global.fetch.mockReturnValue(new Promise((resolve) => { releaseFetch = resolve; }));

        // Start a refresh; it snapshots {token, epoch} under the lock, then parks
        // on the network. We call it directly (not via getAccessToken, which
        // would short-circuit on the warm token).
        const refreshP = mod.refreshAccessToken();
        // Let the snapshot-under-lock resolve and the fetch fire.
        await Promise.resolve();

        // Logout lands in the gap: bumps the epoch, clears both halves.
        await mod.clearTokens();

        // The backend now answers with a full (rotated) session — the exact
        // payload that would resurrect a logged-out session if we committed it.
        releaseFetch({
            ok: true,
            json: async () => ({ access_token: "resurrected", refresh_token: "rotated" }),
        });
        await expect(refreshP).resolves.toBeNull();

        // Session stays dead: nothing persisted, nothing served.
        expect(map.has(REFRESH_KEY)).toBe(false);
        expect(await mod.hasActiveSession()).toBe(false);
        global.fetch.mockResolvedValue({ ok: false, status: 401 });
        await expect(mod.getAccessToken()).rejects.toThrow("no_session");
    });

    it("a rotation-persist FAILURE preserves prior state and fails closed (no torn pair)", async () => {
        const { map, state, mod } = await load({ session: new Map([[REFRESH_KEY, "refresh-old"]]) });
        // Backend rotates the refresh token, but persisting it throws.
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ access_token: "minted", refresh_token: "refresh-rotated" }),
        });
        state.failSetOnce = true;
        // getAccessToken -> refresh -> rotation persist fails -> null -> no_session.
        await expect(mod.getAccessToken()).rejects.toThrow("no_session");
        // Prior refresh token intact; no half-applied rotation.
        expect(map.get(REFRESH_KEY)).toBe("refresh-old");
    });

    it("a refresh network error returns null and never throws out of refresh", async () => {
        const { mod } = await load({ session: new Map([[REFRESH_KEY, "refresh-live"]]) });
        global.fetch.mockRejectedValue(new Error("offline"));
        await expect(mod.refreshAccessToken()).resolves.toBeNull();
    });

    it("a refresh that times out returns null (bounded, never hangs)", async () => {
        vi.useFakeTimers();
        const { mod } = await load({ session: new Map([[REFRESH_KEY, "refresh-live"]]) });
        global.fetch.mockReturnValue(new Promise(() => {})); // never settles
        const p = mod.refreshAccessToken();
        await vi.advanceTimersByTimeAsync(15000);
        await expect(p).resolves.toBeNull();
        vi.useRealTimers();
    });

    it("a malformed refresh body returns null (explicit parse, fail closed)", async () => {
        const { mod } = await load({ session: new Map([[REFRESH_KEY, "refresh-live"]]) });
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => { throw new SyntaxError("bad json"); },
        });
        await expect(mod.refreshAccessToken()).resolves.toBeNull();
    });
});
