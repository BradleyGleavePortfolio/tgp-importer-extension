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
