import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requestStartImport, wireStartImport } from "../popup/popup.js";

// REAL-BEHAVIOR coverage of the popup Start Import CTA (the PR-C1b mandate: the
// Start-Import test must exercise real behavior, NOT a source grep). popup.js
// guards its load-time bootstrap behind `chrome + document` presence, so under
// node the module imports cleanly and we drive the exported wiring directly with
// injected fakes — the actual click path, tab query, and message send.

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeButton() {
  const handlers = {};
  return {
    disabled: false,
    addEventListener(type, fn) {
      handlers[type] = fn;
    },
    fire(type) {
      return handlers[type] ? handlers[type]() : undefined;
    },
  };
}
function fakeDoc(button) {
  return { getElementById: (id) => (id === "start-import" ? button : null) };
}

function grantAll() {
  return { request: vi.fn(async () => true) };
}
function denyAll() {
  return { request: vi.fn(async () => false) };
}

describe("requestStartImport — Authorization = Start", () => {
  it("asks Chrome for the active tab's origin, then sends its url and id", async () => {
    const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const tabs = {
      query: vi.fn(async () => [
        { id: 1, url: "https://app.truecoach.co/clients?client=jane" },
      ]),
    };
    const permissions = grantAll();
    const result = await requestStartImport(runtime, tabs, permissions);
    expect(tabs.query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    // Exactly the tab's origin, as a match pattern, nothing broader.
    expect(permissions.request).toHaveBeenCalledExactlyOnceWith({
      origins: ["https://app.truecoach.co/*"],
    });
    // The tab id rides along so the worker can ask THIS tab's collector for
    // the source bearer; the url is the crawl origin.
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      kind: "start_import",
      url: "https://app.truecoach.co/clients?client=jane",
      tabId: 1,
    });
    expect(result).toEqual({ ok: true });
  });

  it("requests the origin only after the tab query resolves (gesture order)", async () => {
    const order = [];
    const runtime = {
      sendMessage: vi.fn(async () => {
        order.push("send");
        return { ok: true };
      }),
    };
    const tabs = {
      query: vi.fn(async () => {
        order.push("query");
        return [{ id: 3, url: "https://source.example/x" }];
      }),
    };
    const permissions = {
      request: vi.fn(async () => {
        order.push("request");
        return true;
      }),
    };
    await requestStartImport(runtime, tabs, permissions);
    expect(order).toEqual(["query", "request", "send"]);
  });

  it("denial starts nothing: no message is sent and the code is stable", async () => {
    const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const tabs = {
      query: vi.fn(async () => [{ id: 1, url: "https://source.example/x" }]),
    };
    const permissions = denyAll();
    const result = await requestStartImport(runtime, tabs, permissions);
    expect(permissions.request).toHaveBeenCalledOnce();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: "origin_not_authorized" });
  });

  it("treats a non-boolean grant reply as denial", async () => {
    const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const tabs = {
      query: vi.fn(async () => [{ id: 1, url: "https://source.example/x" }]),
    };
    const permissions = { request: vi.fn(async () => "yes") };
    const result = await requestStartImport(runtime, tabs, permissions);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: "origin_not_authorized" });
  });

  it.each([
    ["no active tab", []],
    ["a tab without a url", [{ id: 7 }]],
    ["an http page", [{ id: 7, url: "http://app.truecoach.co/clients" }]],
    ["a chrome page", [{ id: 7, url: "chrome://extensions" }]],
    ["a file page", [{ id: 7, url: "file:///tmp/x.html" }]],
    ["an unparseable url", [{ id: 7, url: "not a url" }]],
  ])(
    "refuses %s before asking Chrome anything (origin_not_https)",
    async (_label, result) => {
      const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
      const tabs = { query: vi.fn(async () => result) };
      const permissions = grantAll();
      const reply = await requestStartImport(runtime, tabs, permissions);
      expect(permissions.request).not.toHaveBeenCalled();
      expect(runtime.sendMessage).not.toHaveBeenCalled();
      expect(reply).toEqual({ ok: false, error: "origin_not_https" });
    },
  );

  it.each([
    "https://api.tgp.coach/x",
    "https://tgp.coach/",
    "https://a.tgp.coach/",
  ])("never asks for a grant on TGP's own origin (%s)", async (url) => {
    const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const tabs = { query: vi.fn(async () => [{ id: 7, url }]) };
    const permissions = grantAll();
    const reply = await requestStartImport(runtime, tabs, permissions);
    expect(permissions.request).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(reply).toEqual({ ok: false, error: "origin_is_tgp" });
  });

  it("sends a null tabId when the active tab has no numeric id", async () => {
    const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const tabs = {
      query: vi.fn(async () => [{ url: "https://app.truecoach.co/clients" }]),
    };
    await requestStartImport(runtime, tabs, grantAll());
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      kind: "start_import",
      url: "https://app.truecoach.co/clients",
      tabId: null,
    });
  });
});

describe("wireStartImport — binds the CTA click to a real gesture", () => {
  const messages = JSON.parse(
    readFileSync(join(process.cwd(), "_locales/en/messages.json"), "utf8"),
  );
  const getMessage = (key) => messages[key].message;
  const sourceTab = [{ id: 1, url: "https://app.truecoach.co/clients" }];

  it.each(["lost reply", "not accepted", "malformed reply", "tab lookup"])(
    "shows safe recovery guidance for %s and allows status inspection",
    async (mode) => {
      const btn = fakeButton();
      const errorBox = { hidden: true, textContent: "" };
      const doc = {
        getElementById: (id) => (id === "error" ? errorBox : btn),
      };
      const runtime = {
        sendMessage: vi.fn(async () => {
          if (mode === "lost reply") throw new Error("PRIVATE_SOURCE_TOKEN");
          return mode === "malformed reply" ? undefined : { ok: false };
        }),
      };
      const tabs = {
        query: vi.fn(async () => {
          if (mode === "tab lookup") throw new Error("PRIVATE_SOURCE_URL");
          return sourceTab;
        }),
      };
      wireStartImport(runtime, tabs, doc, getMessage, grantAll());
      btn.fire("click");
      await flush();
      expect(btn.disabled).toBe(false);
      expect(errorBox.hidden).toBe(false);
      expect(errorBox.textContent).toBe(
        "Start was not confirmed. Check the importer status before trying again.",
      );
      expect(errorBox.textContent).not.toContain("PRIVATE");
    },
  );

  it.each([
    ["declined grant", sourceTab, denyAll(), "prestart_origin_not_authorized"],
    [
      "non-https tab",
      [{ id: 1, url: "http://x.example/" }],
      grantAll(),
      "prestart_unsafe_origin",
    ],
    [
      "TGP tab",
      [{ id: 1, url: "https://api.tgp.coach/" }],
      grantAll(),
      "prestart_unsafe_origin",
    ],
  ])(
    "shows the approved no-run line for a %s and sends nothing",
    async (_label, tabResult, permissions, key) => {
      const btn = fakeButton();
      const errorBox = { hidden: true, textContent: "" };
      const doc = {
        getElementById: (id) => (id === "error" ? errorBox : btn),
      };
      const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
      const tabs = { query: vi.fn(async () => tabResult) };
      wireStartImport(runtime, tabs, doc, getMessage, permissions);
      btn.fire("click");
      await flush();
      await flush();
      expect(runtime.sendMessage).not.toHaveBeenCalled();
      expect(btn.disabled).toBe(false);
      expect(errorBox.hidden).toBe(false);
      expect(errorBox.textContent).toBe(messages[key].message);
      expect(errorBox.textContent).not.toContain("origin_");
    },
  );

  it("shows the approved line when the worker reports a revoked grant", async () => {
    const btn = fakeButton();
    const errorBox = { hidden: true, textContent: "" };
    const doc = { getElementById: (id) => (id === "error" ? errorBox : btn) };
    const runtime = {
      sendMessage: vi.fn(async () => ({
        ok: false,
        error: "origin_not_granted: https://app.truecoach.co",
      })),
    };
    const tabs = { query: vi.fn(async () => sourceTab) };
    wireStartImport(runtime, tabs, doc, getMessage, grantAll());
    btn.fire("click");
    await flush();
    await flush();
    // Worker-side codes are not popup decisions; the popup keeps the generic
    // unconfirmed line and lets the status snapshot carry the approved copy.
    expect(errorBox.textContent).toBe(
      messages.start_import_unconfirmed.message,
    );
  });

  it("clicking requests the grant, sends start_import and toggles the button around the send", async () => {
    const btn = fakeButton();
    const doc = fakeDoc(btn);
    let resolveSend;
    const runtime = {
      sendMessage: vi.fn(
        () =>
          new Promise((r) => {
            resolveSend = r;
          }),
      ),
    };
    const tabs = { query: vi.fn(async () => sourceTab) };
    const permissions = grantAll();

    wireStartImport(runtime, tabs, doc, getMessage, permissions);
    btn.fire("click");
    // Disabled synchronously so a double-click cannot fire two runs.
    expect(btn.disabled).toBe(true);

    await flush();
    expect(tabs.query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://app.truecoach.co/*"],
    });
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      kind: "start_import",
      url: "https://app.truecoach.co/clients",
      tabId: 1,
    });

    // Still disabled until the send settles.
    expect(btn.disabled).toBe(true);
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    resolveSend({ ok: true });
    await flush();
    await flush();
    expect(btn.disabled).toBe(false);
  });

  it("re-enables the button even when the send rejects", async () => {
    const btn = fakeButton();
    const doc = fakeDoc(btn);
    const runtime = {
      sendMessage: vi.fn(async () => {
        throw new Error("port closed");
      }),
    };
    const tabs = { query: vi.fn(async () => sourceTab) };

    wireStartImport(runtime, tabs, doc, getMessage, grantAll());
    btn.fire("click");
    expect(btn.disabled).toBe(true);
    await flush();
    await flush();
    // A rejected send must not leave the CTA disabled forever.
    expect(btn.disabled).toBe(false);
  });

  it("re-enables the button when Chrome's permission prompt itself fails", async () => {
    const btn = fakeButton();
    const doc = fakeDoc(btn);
    const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const tabs = { query: vi.fn(async () => sourceTab) };
    const permissions = {
      request: vi.fn(async () => {
        throw new Error("This function must be called during a user gesture");
      }),
    };
    wireStartImport(runtime, tabs, doc, getMessage, permissions);
    btn.fire("click");
    await flush();
    await flush();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(btn.disabled).toBe(false);
  });

  it("is a no-op when the CTA button is absent", () => {
    const runtime = { sendMessage: vi.fn() };
    const tabs = { query: vi.fn() };
    const doc = { getElementById: () => null };
    expect(() =>
      wireStartImport(runtime, tabs, doc, getMessage, grantAll()),
    ).not.toThrow();
    expect(tabs.query).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe("popup.html — ships the CTA the wiring binds to", () => {
  it("declares the #start-import button (the element wireStartImport looks up)", () => {
    const html = readFileSync(join(process.cwd(), "popup/popup.html"), "utf8");
    expect(html).toMatch(/id="start-import"/);
    expect(html).toMatch(/Start Import/);
  });
});
