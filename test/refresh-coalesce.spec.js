import { describe, it, expect, vi, beforeEach } from "vitest";

// Coalescing concurrent refreshAccessToken calls: same in-flight promise.

const store = new Map();
const chromeMock = {
    storage: {
        session: {
            get: vi.fn(async (key) => {
                const k = typeof key === "string" ? key : Object.keys(key)[0];
                if (!store.has(k)) return {};
                return { [k]: store.get(k) };
            }),
            set: vi.fn(async (obj) => {
                for (const [k, v] of Object.entries(obj)) store.set(k, v);
            }),
            remove: vi.fn(async (key) => {
                store.delete(key);
            }),
        },
    },
};
vi.stubGlobal("chrome", chromeMock);

describe("refreshAccessToken coalescing", () => {
    beforeEach(() => {
        store.clear();
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.stubGlobal("chrome", chromeMock);
    });

    it("dedupes concurrent cold-wake refreshes onto one network call", async () => {
        store.set("tgp_refresh_token", "refresh-1");
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls += 1;
            await new Promise((r) => setTimeout(r, 30));
            return {
                ok: true,
                json: async () => ({ access_token: "access-new", refresh_token: "refresh-2" }),
            };
        });
        vi.stubGlobal("fetch", fetchImpl);
        const session = await import("../shared/session.js");
        const [a, b, c] = await Promise.all([
            session.refreshAccessToken(),
            session.refreshAccessToken(),
            session.refreshAccessToken(),
        ]);
        expect(a).toBe("access-new");
        expect(b).toBe("access-new");
        expect(c).toBe("access-new");
        expect(calls).toBe(1);
    });
});
