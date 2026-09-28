import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { collectShipping } from "../scripts/lib/shipping.mjs";
import { fakePageStore } from "./helpers/source-tab.js";

// The collector is no longer a manifest content script: background.js
// registers it dynamically for the ONE granted origin. The shipping closure
// is the authority on which classic scripts Chrome will load, so boot every
// classic file it reaches (today exactly content/main.js).
const root = fileURLToPath(new URL("..", import.meta.url));
const classicScripts = collectShipping(root)
  .files.filter((file) => file.kind === "classic")
  .map((file) => file.path);

function boot(overrides = {}) {
  const listeners = [];
  const runtime = {
    id: "this-extension",
    onMessage: { addListener: (listener) => listeners.push(listener) },
    sendMessage: vi.fn(async () => undefined),
  };
  const globals = {
    chrome: { runtime },
    location: {
      href: "https://app.truecoach.co/clients",
      origin: "https://app.truecoach.co",
    },
    sessionStorage: fakePageStore(),
    localStorage: fakePageStore(),
  };
  Object.defineProperties(globals, Object.getOwnPropertyDescriptors(overrides));
  expect(classicScripts).toEqual(["content/main.js"]);
  for (const file of classicScripts) {
    // Dynamically registered content scripts are classic scripts, not ES
    // modules. Execute the exact shipping bytes without Vitest's module
    // transformation.
    const script = new Script(
      readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
      { filename: file },
    );
    script.runInNewContext(globals, { timeout: 1000 });
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

describe("dynamically registered content script entrypoint", () => {
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
      origin: "https://app.truecoach.co",
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
      origin: "https://app.truecoach.co",
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
      origin: "https://app.truecoach.co",
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
