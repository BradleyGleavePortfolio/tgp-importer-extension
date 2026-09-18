import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { fakePageStore } from "./helpers/source-tab.js";

function boot(overrides = {}) {
  const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
  );
  const listeners = [];
  const runtime = {
    id: "this-extension",
    onMessage: { addListener: (listener) => listeners.push(listener) },
    sendMessage: vi.fn(async () => undefined),
  };
  const globals = {
    chrome: { runtime },
    location: { href: "https://app.truecoach.co/clients" },
    sessionStorage: fakePageStore(),
    localStorage: fakePageStore(),
  };
  Object.defineProperties(globals, Object.getOwnPropertyDescriptors(overrides));
  for (const entry of manifest.content_scripts) {
    for (const file of entry.js) {
      // Manifest content scripts are classic scripts, not ES modules. Execute
      // the exact shipping bytes without Vitest's module transformation.
      const script = new Script(
        readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
        { filename: file },
      );
      script.runInNewContext(globals, { timeout: 1000 });
    }
  }
  return {
    runtime,
    listeners,
    request: (
      /** @type {unknown} */ sender = { id: runtime.id },
      message = { kind: "collect_source_token" },
    ) => {
      const reply = vi.fn();
      const kept = listeners[0](message, sender, reply);
      return { reply, kept };
    },
  };
}

describe("manifest content script entrypoint", () => {
  it("keeps the credential listener available after a failed announcement without logging secrets", async () => {
    const listeners = [];
    const warn = vi.fn();
    const runtime = {
      id: "this-extension",
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: vi.fn(async () => {
        throw new Error("PRIVATE_SOURCE_TOKEN");
      }),
    };
    boot({ chrome: { runtime }, console: { warn } });
    await Promise.resolve();
    expect(listeners).toHaveLength(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        src: "tgp-importer",
        event: "source_tab_announcement_failed",
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
  });

  it("loads as a classic script and registers the live credential producer", () => {
    const page = boot({
      localStorage: fakePageStore([["auth", "one.two.three"]]),
    });
    expect(page.listeners).toHaveLength(1);
    expect(page.runtime.sendMessage).toHaveBeenCalledWith({
      kind: "platform_tab_live",
      url: "https://app.truecoach.co/clients",
    });
    const { reply, kept } = page.request();
    expect(reply).toHaveBeenCalledExactlyOnceWith({
      ok: true,
      token: "one.two.three",
    });
    expect(kept).toBe(false);
  });

  it("reads credentials at request time, not at page-load time", () => {
    const store = fakePageStore();
    const page = boot({ localStorage: store });
    expect(page.request().reply).toHaveBeenCalledWith({ ok: false });
    store.setItem("auth", "fresh.session.token");
    expect(page.request().reply).toHaveBeenCalledWith({
      ok: true,
      token: "fresh.session.token",
    });
  });

  it("still registers when page storage access is denied, without leaking the error", () => {
    const page = boot({
      get sessionStorage() {
        throw new Error("SYNTHETIC_PRIVATE_STORAGE_ERROR");
      },
      get localStorage() {
        throw new Error("SYNTHETIC_PRIVATE_STORAGE_ERROR");
      },
    });
    expect(page.listeners).toHaveLength(1);
    expect(page.request().reply).toHaveBeenCalledExactlyOnceWith({ ok: false });
    expect(JSON.stringify(page.runtime.sendMessage.mock.calls)).not.toContain(
      "PRIVATE",
    );
  });

  it("ignores denied session storage while consulting available local storage", () => {
    const page = boot({
      get sessionStorage() {
        throw new Error("denied");
      },
      localStorage: fakePageStore([["auth", "local.only.token"]]),
    });
    expect(page.request().reply).toHaveBeenCalledExactlyOnceWith({
      ok: true,
      token: "local.only.token",
    });
  });

  it("does not read storage for an untrusted sender or unrelated message", () => {
    const access = vi.fn(() => {
      throw new Error("must not read");
    });
    const page = boot({
      get sessionStorage() {
        return access();
      },
    });
    for (const sender of [{ id: "foreign-extension" }, {}, null]) {
      expect(page.request(sender).reply).not.toHaveBeenCalled();
    }
    expect(
      page.request({ id: page.runtime.id }, { kind: "unrelated" }).reply,
    ).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
  });

  it("contains a failing storage implementation at the request boundary", () => {
    const page = boot({
      sessionStorage: {
        length: 1,
        key: () => "auth",
        getItem: () => {
          throw new Error("SYNTHETIC_PRIVATE_VALUE");
        },
      },
    });
    expect(page.request().reply).toHaveBeenCalledExactlyOnceWith({ ok: false });
  });
});
