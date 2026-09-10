import { describe, it, expect, vi, beforeEach } from "vitest";

// The refresh endpoint prefix defect, pinned at the wire.
//
// The backend mounts a global `api` prefix whose exclude list does NOT contain
// `auth`, so the real route is /api/auth/extension/refresh. The extension asked
// for /auth/extension/refresh, which 404s. Effect: a valid refresh token sat in
// chrome.storage.session and was never usable, so every cold service-worker wake
// dead-ended in "please re-pair" — the worst kind of failure, because the
// credential the coach needs is right there and simply never redeemed.
//
// The second half of this file is the regression the fix must not cause: a
// failing refresh must NEVER destroy the persisted refresh token. Silently
// dropping it on a 404/500/timeout would turn a transient backend blip into a
// forced re-pair, which is the very failure the prefix fix exists to remove.

const REFRESH_KEY = "tgp_refresh_token";
const CORRECT_ENDPOINT = "https://api.tgp.coach/api/auth/extension/refresh";
const OLD_BROKEN_ENDPOINT = "https://api.tgp.coach/auth/extension/refresh";

// @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
function installChromeStub({ session } = {}) {
  const map = new Map(session ?? []);
  globalThis.chrome = {
    storage: {
      // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
      session: {
        get: async (key) => (map.has(key) ? { [key]: map.get(key) } : {}),
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) map.set(k, v);
        },
        remove: async (key) => {
          map.delete(key);
        },
      },
    },
  };
  return map;
}

async function load(session) {
  vi.resetModules();
  const map = installChromeStub({ session });
  global.fetch = vi.fn();
  const mod = await import("../shared/session.js");
  return { map, mod };
}

function seeded() {
  return new Map([[REFRESH_KEY, "refresh-1"]]);
}

function okRefresh(body = { access_token: "access-2" }) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("refresh endpoint path", () => {
  it("posts to the /api-prefixed route", async () => {
    const { mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue(okRefresh());
    await mod.refreshAccessToken();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    expect(global.fetch.mock.calls[0][0]).toBe(CORRECT_ENDPOINT);
  });

  it("never posts to the old unprefixed route", async () => {
    const { mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue(okRefresh());
    await mod.refreshAccessToken();
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    const urls = global.fetch.mock.calls.map(([url]) => url);
    expect(urls).not.toContain(OLD_BROKEN_ENDPOINT);
  });

  it("uses the same prefixed route on the lazy cold-wake mint", async () => {
    const { mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue(okRefresh());
    await expect(mod.getAccessToken()).resolves.toBe("access-2");
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    expect(global.fetch.mock.calls[0][0]).toBe(CORRECT_ENDPOINT);
  });

  it("still sends the refresh token as a snake_case JSON body", async () => {
    const { mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue(okRefresh());
    await mod.refreshAccessToken();
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    const [, init] = global.fetch.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ refresh_token: "refresh-1" });
  });

  it("does not send an Authorization header (refresh is a @Public route)", async () => {
    const { mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue(okRefresh());
    await mod.refreshAccessToken();
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("makes no network call at all when no refresh token is persisted", async () => {
    const { mod } = await load();
    await expect(mod.refreshAccessToken()).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("no refresh-token persistence regression", () => {
  it("keeps the stored token when the endpoint 404s", async () => {
    const { map, mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(mod.refreshAccessToken()).resolves.toBeNull();
    expect(map.get(REFRESH_KEY)).toBe("refresh-1");
  });

  it.each([[401], [403], [500], [503]])(
    "keeps the stored token on a %i",
    async (status) => {
      const { map, mod } = await load(seeded());
      // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
      global.fetch.mockResolvedValue({ ok: false, status });
      await expect(mod.refreshAccessToken()).resolves.toBeNull();
      expect(map.get(REFRESH_KEY)).toBe("refresh-1");
    },
  );

  it("keeps the stored token when the network call rejects", async () => {
    const { map, mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockRejectedValue(new Error("offline"));
    await expect(mod.refreshAccessToken()).resolves.toBeNull();
    expect(map.get(REFRESH_KEY)).toBe("refresh-1");
  });

  it("keeps the stored token when the response body is unparseable", async () => {
    const { map, mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    });
    await expect(mod.refreshAccessToken()).resolves.toBeNull();
    expect(map.get(REFRESH_KEY)).toBe("refresh-1");
  });

  it("keeps the stored token when the body carries no access_token", async () => {
    const { map, mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue(okRefresh({ token: "wrong-field" }));
    await expect(mod.refreshAccessToken()).resolves.toBeNull();
    expect(map.get(REFRESH_KEY)).toBe("refresh-1");
  });

  it("leaves the session recoverable after a failed refresh (no forced re-pair)", async () => {
    const { mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue({ ok: false, status: 500 });
    await mod.refreshAccessToken();
    await expect(mod.hasActiveSession()).resolves.toBe(true);
  });

  it("a later successful refresh works after an earlier failure", async () => {
    const { map, mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(mod.refreshAccessToken()).resolves.toBeNull();
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValueOnce(okRefresh());
    await expect(mod.refreshAccessToken()).resolves.toBe("access-2");
    expect(map.get(REFRESH_KEY)).toBe("refresh-1"); // unrotated, still intact
  });

  it("persists a rotated refresh token when the backend supplies one", async () => {
    const { map, mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue(
      okRefresh({ access_token: "access-2", refresh_token: "refresh-2" }),
    );
    await expect(mod.refreshAccessToken()).resolves.toBe("access-2");
    expect(map.get(REFRESH_KEY)).toBe("refresh-2");
  });

  it("keeps the refresh token in session storage only — never on disk", async () => {
    const { map, mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue(okRefresh());
    await mod.refreshAccessToken();
    expect(chrome.storage.local).toBeUndefined();
    expect(map.get(REFRESH_KEY)).toBe("refresh-1");
  });

  it("never puts the refresh token in the request URL", async () => {
    const { mod } = await load(seeded());
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue(okRefresh());
    await mod.refreshAccessToken();
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    expect(global.fetch.mock.calls[0][0]).not.toContain("refresh-1");
  });
});
