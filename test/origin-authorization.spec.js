import { describe, it, expect, vi } from "vitest";
import {
  makeBgMock,
  installChrome,
  acceptedIngest,
} from "./helpers/background-mock.js";
import { fakePageStore, realSourceTab } from "./helpers/source-tab.js";

// Authorization = Start, worker side. The popup's Start gesture grants ONE
// https origin; the worker never trusts that claim. It re-checks the grant
// with chrome.permissions.contains, refuses TGP's own origins, holds the
// granted origin as the run's single authorized origin (memory only, dropped
// when the run settles), registers the collector dynamically for exactly that
// origin, and resolves the reader by registry lookup — an unknown origin
// fails closed with a truthful "not learned" code. No vendor name is consulted
// anywhere on this path; the oracle under legacy/ registers itself.

const REFRESH_KEY = "tgp_refresh_token";
const REFRESH_URL = "https://api.tgp.coach/api/auth/extension/refresh";
const INGEST_URL = "https://api.tgp.coach/api/scout/ingest";
const COMPLETE_URL = "https://api.tgp.coach/api/scout/ingest/complete";
const CLIENTS_PREFIX = "https://app.truecoach.co/proxy/api/clients?";
const TAB_URL = "https://app.truecoach.co/clients?client=jane.doe";
const TAB_ORIGIN = "https://app.truecoach.co";
const TAB_ID = 42;
const SRC_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb2FjaCJ9.s1g-nature_TOKEN";
const EXT_ID = "test-extension-id";

function withSourceTab(opts = {}) {
  const stores = [fakePageStore(), fakePageStore([["truecoach.jwt", SRC_JWT]])];
  return { url: TAB_URL, sendMessage: realSourceTab(EXT_ID, stores), ...opts };
}

// @ts-expect-error -- partial mock shape, same convention as start-import.spec.
async function load({ session, tab, granted } = {}) {
  vi.resetModules();
  const mock = makeBgMock({ session, tab, granted });
  installChrome(mock);
  global.fetch = vi.fn();
  // Same module registry as background.js, so the session owner we inspect is
  // the one the worker writes to.
  const sessionModule = await import("../shared/session.js");
  await import("../background.js");
  return { mock, sessionModule };
}

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

async function settle(mock, ms = 10000) {
  const start = Date.now();
  for (;;) {
    const last = snapshots(mock).at(-1);
    const status = last && last.intent ? last.intent.status : null;
    if (
      status === "ingest_succeeded" ||
      status === "ingest_failed" ||
      status === "ingest_partial"
    ) {
      return status;
    }
    if (Date.now() - start > ms) return status;
    await flush(2);
  }
}

// A minimal successful source + TGP fixture: one client, no notes.
function routeSuccess(mock) {
  // @ts-expect-error -- vi.fn on global.fetch
  global.fetch.mockImplementation(async (url, init) => {
    if (url === REFRESH_URL) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "TGP-ACCESS" }),
      };
    }
    if (url.startsWith(CLIENTS_PREFIX) && url.includes("page=1")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ clients: [{ id: "c1" }] }),
      };
    }
    if (url.startsWith(CLIENTS_PREFIX)) {
      return { ok: true, status: 200, json: async () => ({ clients: [] }) };
    }
    if (url.startsWith("https://app.truecoach.co/proxy/api/clients/c1/")) {
      return { ok: true, status: 200, json: async () => ({ notes: [] }) };
    }
    if (url === INGEST_URL) return acceptedIngest(init);
    if (url === COMPLETE_URL) return { ok: true, status: 200 };
    throw new Error(`unrouted fetch ${url}`);
  });
  return mock;
}

describe("start_import — the worker re-checks the grant it was told about", () => {
  it("refuses an origin Chrome does not hold a host grant for, touching nothing", async () => {
    const { mock, sessionModule } = await load({
      session: new Map([[REFRESH_KEY, "seed-refresh"]]),
      tab: withSourceTab(),
      granted: false,
    });
    const ack = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(ack).toEqual({ ok: true });
    await flush();
    const last = snapshots(mock).at(-1);
    // Origin only — never the path or query of the coach's tab.
    expect(last.lastError).toBe(`origin_not_granted: ${TAB_ORIGIN}`);
    expect(last.lastError).not.toContain("jane.doe");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mock.tabMessages).toHaveLength(0);
    expect(mock.scripting.registered).toHaveLength(0);
    expect(mock.scripting.executed).toHaveLength(0);
    expect(sessionModule.getAuthorizedOrigin()).toBeNull();
  });

  it.each([
    "https://api.tgp.coach/x",
    "https://tgp.coach/",
    "https://x.tgp.coach/y",
  ])(
    "refuses TGP's own origin %s even when granted (never self-import)",
    async (url) => {
      const { mock } = await load({
        session: new Map([[REFRESH_KEY, "seed-refresh"]]),
        tab: withSourceTab({ url }),
      });
      await mock.dispatch({ kind: "start_import", url, tabId: TAB_ID });
      await flush();
      expect(snapshots(mock).at(-1).lastError).toBe(
        `origin_is_tgp: ${new URL(url).origin}`,
      );
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mock.scripting.registered).toHaveLength(0);
    },
  );

  it("refuses a granted https origin nobody has learned, before any TGP auth", async () => {
    const { mock } = await load({
      // No TGP session at all: the not-learned verdict must still win, so the
      // coach is never sent to pairing for a site that cannot be imported.
      tab: withSourceTab({ url: "https://unlearned.example/app" }),
    });
    await mock.dispatch({
      kind: "start_import",
      url: "https://unlearned.example/app?secret=1",
      tabId: TAB_ID,
    });
    await flush();
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toBe("site_not_learned: https://unlearned.example");
    expect(last.lastError).not.toContain("secret");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mock.sent.some((m) => m && m.kind === "auth_required")).toBe(false);
    expect(mock.tabMessages).toHaveLength(0);
  });

  it("start_ingest is held to the same grant check", async () => {
    const { mock } = await load({
      session: new Map([[REFRESH_KEY, "seed-refresh"]]),
      granted: false,
    });
    await mock.dispatch({ kind: "start_ingest", url: TAB_URL });
    await flush();
    expect(snapshots(mock).at(-1).lastError).toBe(
      `origin_not_granted: ${TAB_ORIGIN}`,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("start_import — the granted origin is the run's single authorized origin", () => {
  it("holds the origin for the run, registers the collector for exactly that origin, and drops both when the run settles", async () => {
    const { mock, sessionModule } = await load({
      session: new Map([[REFRESH_KEY, "seed-refresh"]]),
      tab: withSourceTab(),
    });
    routeSuccess(mock);
    const ack = await mock.dispatch({
      kind: "start_import",
      url: TAB_URL,
      tabId: TAB_ID,
    });
    expect(ack).toEqual({ ok: true });
    // Bound synchronously with admission: the origin is authorized before the
    // handler yields, so a racing capture request sees the run's origin.
    expect(sessionModule.getAuthorizedOrigin()).toBe(TAB_ORIGIN);

    const terminal = await settle(mock);
    expect(terminal).toBe("ingest_succeeded");

    // Dynamic registration: the collector was registered for `${origin}/*`
    // only, injected into the coach's tab, and never persisted across sessions.
    expect(mock.scripting.registered).toEqual([
      {
        id: "tgp-source-collector",
        js: ["content/main.js"],
        matches: [`${TAB_ORIGIN}/*`],
        runAt: "document_idle",
        persistAcrossSessions: false,
      },
    ]);
    expect(mock.scripting.executed).toEqual([
      { target: { tabId: TAB_ID }, files: ["content/main.js"] },
    ]);
    // The token was collected from the tab (the real producer answered).
    expect(mock.tabMessages).toEqual([
      { id: TAB_ID, message: { kind: "collect_source_token" } },
    ]);

    // Settled: authorization ends with the run.
    await flush();
    expect(sessionModule.getAuthorizedOrigin()).toBeNull();
    expect(
      mock.scripting.unregistered.some((f) =>
        f.ids.includes("tgp-source-collector"),
      ),
    ).toBe(true);
    // Nothing about the origin reached persistent storage.
    for (const value of mock.sessionMap.values()) {
      expect(String(value)).not.toContain(TAB_ORIGIN);
    }
  }, 15000);

  it("drops the authorized origin when the run fails before crawling", async () => {
    const { mock, sessionModule } = await load({
      // Granted, learned, but no TGP session: preflight fails closed.
      tab: withSourceTab(),
    });
    await mock.dispatch({ kind: "start_import", url: TAB_URL, tabId: TAB_ID });
    expect(sessionModule.getAuthorizedOrigin()).toBe(TAB_ORIGIN);
    await flush();
    expect(sessionModule.getAuthorizedOrigin()).toBeNull();
    expect(mock.sent.some((m) => m && m.kind === "auth_required")).toBe(true);
  });
});

describe("no vendor knowledge on the core path", () => {
  it("background.js reaches the oracle through exactly one legacy import and names no vendor", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../background.js", import.meta.url),
      "utf8",
    );
    const legacyImports = source.match(/^import\s+"\.\/legacy\/index\.js";$/gm);
    expect(legacyImports).toHaveLength(1);
    expect(source).not.toMatch(/truecoach/i);
    expect(source).not.toMatch(/extractors\/detect/);
  });

  it("no core module names the oracle's vendor", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL("..", import.meta.url).pathname;
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".js")) files.push(full);
      }
    };
    for (const dir of ["shared", "popup", "content", "extractors"]) {
      walk(join(root, dir));
    }
    files.push(join(root, "background.js"), join(root, "manifest.json"));
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/truecoach/i);
    }
  });
});
