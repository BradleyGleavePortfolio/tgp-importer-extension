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

// The messages a (partial-shape) runtime mock received, in order.
function sentMessages(runtime) {
  return /** @type {any[]} */ (
    /** @type {any} */ (runtime.sendMessage).mock.calls.map((c) => c[0])
  );
}

describe("requestStartImport — Authorization = Start", () => {
  it("registers the Start with the worker, then asks Chrome for that one origin", async () => {
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
    // the source bearer; the url is the crawl origin; the nonce binds this
    // registration to the grant the prompt is about to produce.
    const sent = sentMessages(runtime)[0];
    expect(sent.kind).toBe("start_import");
    expect(sent.url).toBe("https://app.truecoach.co/clients?client=jane");
    expect(sent.tabId).toBe(1);
    expect(typeof sent.nonce).toBe("string");
    expect(sent.nonce.length).toBeGreaterThan(8);
    expect(result).toEqual({ ok: true });
  });

  it("registers BEFORE it prompts, so the run survives the prompt closing the popup", async () => {
    // R35B-B3 / R35-A-02: the old order (prompt, then send) meant a popup the
    // prompt closed never sent Start, leaving the coach's grant held with no
    // run, and a cold worker that processed the message before onAdded revoked
    // the grant it had just been given. The registration now goes first.
    const order = [];
    const runtime = {
      sendMessage: vi.fn(async (message) => {
        order.push(`send:${message.kind}`);
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
    // The trailing start_granted only lets the worker refuse a grant Chrome
    // held BEFORE this Start; the run itself is started by the grant event.
    expect(order).toEqual([
      "query",
      "send:start_import",
      "request",
      "send:start_granted",
    ]);
  });

  it("a refused registration never prompts the coach", async () => {
    const runtime = {
      sendMessage: vi.fn(async () => ({
        ok: false,
        error: "import_in_progress",
      })),
    };
    const tabs = {
      query: vi.fn(async () => [{ id: 1, url: "https://source.example/x" }]),
    };
    const permissions = grantAll();
    const result = await requestStartImport(runtime, tabs, permissions);
    expect(permissions.request).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: "import_in_progress" });
  });

  it("denial starts nothing and tells the worker to drop its pending Start", async () => {
    const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const tabs = {
      query: vi.fn(async () => [{ id: 1, url: "https://source.example/x" }]),
    };
    const permissions = denyAll();
    const result = await requestStartImport(runtime, tabs, permissions);
    expect(permissions.request).toHaveBeenCalledOnce();
    const kinds = sentMessages(runtime).map((m) => m.kind);
    expect(kinds).toEqual(["start_import", "start_unavailable"]);
    // The cancellation carries the SAME nonce, so only this gesture's Start
    // can be cancelled by it.
    const [registered, cancelled] = sentMessages(runtime);
    expect(cancelled.nonce).toBe(registered.nonce);
    expect(result).toEqual({ ok: false, error: "origin_not_authorized" });
  });

  it("treats a non-boolean grant reply as denial", async () => {
    const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const tabs = {
      query: vi.fn(async () => [{ id: 1, url: "https://source.example/x" }]),
    };
    const permissions = { request: vi.fn(async () => "yes") };
    const result = await requestStartImport(runtime, tabs, permissions);
    expect(sentMessages(runtime).map((m) => m.kind)).toEqual([
      "start_import",
      "start_unavailable",
    ]);
    expect(result).toEqual({ ok: false, error: "origin_not_authorized" });
  });

  it("a lost cancellation is not fatal: the honest code still reaches the coach", async () => {
    // The worker expires its own pending Start (and revokes any grant) on its
    // deadline, so a dropped start_unavailable never strands the coach.
    const runtime = {
      sendMessage: vi.fn(async (message) => {
        if (message.kind === "start_unavailable")
          throw new Error("port closed");
        return { ok: true };
      }),
    };
    const tabs = {
      query: vi.fn(async () => [{ id: 1, url: "https://source.example/x" }]),
    };
    const result = await requestStartImport(runtime, tabs, denyAll());
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
    "https://backend-spring-lake-3890.fly.dev/x",
    "https://backend-spring-lake-3890.fly.dev/",
    "https://BACKEND-SPRING-LAKE-3890.FLY.DEV/api",
  ])("never asks for a grant on TGP's own origin (%s)", async (url) => {
    const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const tabs = { query: vi.fn(async () => [{ id: 7, url }]) };
    const permissions = grantAll();
    const reply = await requestStartImport(runtime, tabs, permissions);
    expect(permissions.request).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(reply).toEqual({ ok: false, error: "origin_is_tgp" });
  });

  it("R35-c7A-01: a tab with no numeric id is refused (source_tab_required) — nothing sent, Chrome never prompted", async () => {
    // Before r4 the popup sent `tabId: null` and the worker ran a cookie-only
    // replay with no verified live tab at all.
    const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const tabs = {
      query: vi.fn(async () => [{ url: "https://app.truecoach.co/clients" }]),
    };
    const permissions = grantAll();
    const reply = await requestStartImport(runtime, tabs, permissions);
    expect(reply).toEqual({ ok: false, error: "source_tab_required" });
    expect(sentMessages(runtime)).toHaveLength(0);
    expect(permissions.request).not.toHaveBeenCalled();
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
      [{ id: 1, url: "https://backend-spring-lake-3890.fly.dev/" }],
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
      // No RUN is ever asked for. A declined grant does send the worker its
      // own cancellation (so the pending Start and any grant end at once);
      // an unsafe origin never reaches the worker at all.
      expect(
        sentMessages(runtime).filter((m) => m.kind === "start_import"),
      ).toHaveLength(_label === "declined grant" ? 1 : 0);
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
      // The registration is held open; the follow-up (start_granted) is not.
      sendMessage: vi.fn((message) =>
        message.kind === "start_import"
          ? new Promise((r) => {
              resolveSend = r;
            })
          : Promise.resolve({ ok: true }),
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
    const sent = sentMessages(runtime)[0];
    expect(sent.kind).toBe("start_import");
    expect(sent.url).toBe("https://app.truecoach.co/clients");
    expect(sent.tabId).toBe(1);

    // Still disabled until the registration settles.
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
    // The registration went out and was then cancelled; no run was confirmed.
    expect(sentMessages(runtime).map((m) => m.kind)).toEqual([
      "start_import",
      "start_unavailable",
    ]);
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
