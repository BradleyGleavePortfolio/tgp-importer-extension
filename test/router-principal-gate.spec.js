import { describe, it, expect, vi } from "vitest";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";

// Every entrypoint that spends a credential, drives chrome.debugger, or returns
// captured traffic is gated by the FULL trusted-extension-page sender shape —
// not an extension-id match alone. A content script shares our id, carries a
// web-page URL and an originating tab, and must be refused on all of them.
// Also pins: persisted/displayed pre-run error text names the tab ORIGIN only,
// never a full source URL (paths and queries can identify a client).

const REFRESH_KEY = "tgp_refresh_token";
const TAB_URL = "https://app.truecoach.co/clients/4711/notes?client=jane.doe";

async function load() {
  vi.resetModules();
  const mock = makeBgMock({
    session: new Map([[REFRESH_KEY, "seed"]]),
    tab: { url: TAB_URL },
  });
  installChrome(mock);
  global.fetch = vi.fn();
  await import("../background.js");
  return mock;
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

const contentScriptSender = {
  id: "test-extension-id",
  url: TAB_URL,
  tab: { id: 9 },
};

describe("router: content-script principal is refused on every privileged kind", () => {
  it.each([
    [{ kind: "start_ingest", url: TAB_URL, sourceToken: "forged" }],
    [{ kind: "start_capture", tabId: 9 }],
    [{ kind: "stop_capture", tabId: 9 }],
    [{ kind: "start_import", url: TAB_URL, tabId: 9 }],
  ])("%o -> untrusted_sender, no side effects", async (message) => {
    const mock = await load();
    const attach = vi.spyOn(mock.chrome.debugger, "attach");
    const detach = vi.spyOn(mock.chrome.debugger, "detach");
    const ack = await mock.dispatch(message, contentScriptSender);
    expect(ack).toEqual({ ok: false, error: "untrusted_sender" });
    await flush();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(snapshots(mock)).toHaveLength(0);
  });

  it("still serves the same kinds to a trusted extension page (gate is on principal, not kind)", async () => {
    const mock = await load();
    // A trusted page reaches the tabId validation, i.e. past the principal gate.
    const capture = await mock.dispatch({ kind: "start_capture" });
    expect(capture).toEqual({
      ok: false,
      error: "start_capture: missing tabId",
    });
    const stop = await mock.dispatch({ kind: "stop_capture" });
    expect(stop).toEqual({ ok: false, error: "stop_capture: missing tabId" });
  });
});

describe("router: pre-run error text carries the tab origin only", () => {
  it("unsupported site", async () => {
    const mock = await load();
    const url = "https://example.com/coach/jane.doe/clients?token=abc";
    await mock.dispatch({ kind: "start_import", url });
    await flush();
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toBe("unsupported site: https://example.com");
    expect(last.lastError).not.toContain("jane.doe");
    expect(last.lastError).not.toContain("token=");
  });

  it("unsafe import origin", async () => {
    const mock = await load();
    const url = "http://app.truecoach.co/clients/4711?client=jane.doe";
    await mock.dispatch({ kind: "start_import", url });
    await flush();
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toBe(
      "unsafe import origin: http://app.truecoach.co",
    );
    expect(last.lastError).not.toContain("4711");
  });

  it("legacy start_ingest from a trusted page", async () => {
    const mock = await load();
    await mock.dispatch({
      kind: "start_ingest",
      url: "https://example.com/coach/jane.doe",
    });
    await flush();
    expect(snapshots(mock).at(-1).lastError).toBe(
      "unsupported site: https://example.com",
    );
  });

  it("an unparseable url is described without echoing it", async () => {
    const mock = await load();
    await mock.dispatch({ kind: "start_import", url: "not a url jane.doe" });
    await flush();
    expect(snapshots(mock).at(-1).lastError).toBe(
      "unsupported site: (invalid url)",
    );
  });
});
