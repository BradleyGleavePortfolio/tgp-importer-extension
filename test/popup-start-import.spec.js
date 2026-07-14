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
        addEventListener(type, fn) { handlers[type] = fn; },
        fire(type) { return handlers[type] ? handlers[type]() : undefined; },
    };
}
function fakeDoc(button) {
    return { getElementById: (id) => (id === "start-import" ? button : null) };
}

describe("requestStartImport — posts a start_import for the active tab", () => {
    it("queries the active tab and sends its url", async () => {
        const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
        const tabs = { query: vi.fn(async () => [{ id: 1, url: "https://app.truecoach.co/clients" }]) };
        await requestStartImport(runtime, tabs);
        expect(tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
        expect(runtime.sendMessage).toHaveBeenCalledWith({
            kind: "start_import",
            url: "https://app.truecoach.co/clients",
        });
    });

    it("sends an empty url when there is no active tab (worker rejects it)", async () => {
        const runtime = { sendMessage: vi.fn(async () => ({ ok: false })) };
        const tabs = { query: vi.fn(async () => []) };
        await requestStartImport(runtime, tabs);
        expect(runtime.sendMessage).toHaveBeenCalledWith({ kind: "start_import", url: "" });
    });

    it("sends an empty url when the active tab has no url property", async () => {
        const runtime = { sendMessage: vi.fn(async () => ({ ok: true })) };
        const tabs = { query: vi.fn(async () => [{ id: 1 }]) };
        await requestStartImport(runtime, tabs);
        expect(runtime.sendMessage).toHaveBeenCalledWith({ kind: "start_import", url: "" });
    });
});

describe("wireStartImport — binds the CTA click to a real send", () => {
    it("clicking sends start_import and toggles the button around the send", async () => {
        const btn = fakeButton();
        const doc = fakeDoc(btn);
        let resolveSend;
        const runtime = { sendMessage: vi.fn(() => new Promise((r) => { resolveSend = r; })) };
        const tabs = { query: vi.fn(async () => [{ url: "https://app.truecoach.co/clients" }]) };

        wireStartImport(runtime, tabs, doc);
        btn.fire("click");
        // Disabled synchronously so a double-click cannot fire two runs.
        expect(btn.disabled).toBe(true);

        await flush();
        expect(tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
        expect(runtime.sendMessage).toHaveBeenCalledWith({
            kind: "start_import",
            url: "https://app.truecoach.co/clients",
        });

        // Still disabled until the send settles.
        expect(btn.disabled).toBe(true);
        resolveSend({ ok: true });
        await flush();
        await flush();
        expect(btn.disabled).toBe(false);
    });

    it("re-enables the button even when the send rejects", async () => {
        const btn = fakeButton();
        const doc = fakeDoc(btn);
        const runtime = { sendMessage: vi.fn(async () => { throw new Error("port closed"); }) };
        const tabs = { query: vi.fn(async () => [{ url: "https://app.truecoach.co/clients" }]) };

        wireStartImport(runtime, tabs, doc);
        btn.fire("click");
        expect(btn.disabled).toBe(true);
        await flush();
        await flush();
        // A rejected send must not leave the CTA disabled forever.
        expect(btn.disabled).toBe(false);
    });

    it("is a no-op when the CTA button is absent", () => {
        const runtime = { sendMessage: vi.fn() };
        const tabs = { query: vi.fn() };
        const doc = { getElementById: () => null };
        expect(() => wireStartImport(runtime, tabs, doc)).not.toThrow();
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
