import { describe, it, expect, beforeEach } from "vitest";
import { makeChromeMock, installChrome } from "./helpers/chrome-mock.js";
import {
  attachDebugger,
  stopCapture,
  retireCaptureSessions,
  registerCaptureLifecycle,
} from "../shared/capture.js";
import {
  clearAuthorizedOrigin,
  setAuthorizedOrigin,
} from "../shared/session.js";

// Capture is a capability of the CURRENT run only (review A1/A2). These tests
// fail on 7ac1fe9, where a debugger attached under run A kept receiving events
// and reading bodies after A settled and B became the authorized origin, and
// where the handle followed a tab that navigated to another origin.

const TAB = 7;
const A = "https://app.truecoach.co";
const B = "https://other.example";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function emitJson(mock, tabId, requestId, url, extra = {}) {
  const source = { tabId };
  mock.emit(source, "Network.requestWillBeSent", {
    requestId,
    request: { url, method: "GET", headers: {} },
    ...extra,
  });
  mock.emit(source, "Network.responseReceived", {
    requestId,
    response: { mimeType: "application/json", status: 200 },
  });
  mock.emit(source, "Network.loadingFinished", {
    requestId,
    encodedDataLength: 10,
  });
}

function bodyReads(mock) {
  return mock.calls.sendCommand.filter(
    (c) => c.method === "Network.getResponseBody",
  );
}

describe("A1 — capture ends with the run", () => {
  let mock;
  beforeEach(() => {
    mock = makeChromeMock();
    installChrome(mock);
    mock.onCommand("Network.getResponseBody", () => ({
      body: JSON.stringify({ secret: "client-data" }),
      base64Encoded: false,
    }));
  });

  it("retireCaptureSessions detaches every debugger and drains it; a later stop yields nothing", async () => {
    await attachDebugger(TAB);
    emitJson(mock, TAB, "r1", `${A}/proxy/api/clients`);
    await retireCaptureSessions();
    expect(mock.calls.detach).toContainEqual({ target: { tabId: TAB } });
    expect(mock.listenerCount()).toBe(0);
    const late = await stopCapture(TAB);
    expect(late.entries).toEqual([]);
  });

  it("A -> B: events on an A tab after A's run settled are refused and the debugger is detached", async () => {
    await attachDebugger(TAB);
    // Run A settles; run B is now the only authorized origin.
    await retireCaptureSessions();
    setAuthorizedOrigin(B);
    mock.grant(`${B}/*`);
    const reads = bodyReads(mock).length;
    // A stale listener (had one survived) must never read a body.
    emitJson(mock, TAB, "r2", `${A}/proxy/api/clients`);
    await flush();
    expect(bodyReads(mock).length).toBe(reads);
    expect((await stopCapture(TAB)).entries).toEqual([]);
  });

  it("a session whose origin stops being authorized mid-run reads no more bodies and tears down", async () => {
    await attachDebugger(TAB);
    emitJson(mock, TAB, "r1", `${A}/proxy/api/clients`);
    await flush();
    expect(bodyReads(mock)).toHaveLength(1);
    // The run's authorization is withdrawn (settle / TGP session clear) while
    // the debugger is still attached.
    clearAuthorizedOrigin();
    emitJson(mock, TAB, "r2", `${A}/proxy/api/clients`);
    await flush();
    expect(bodyReads(mock)).toHaveLength(1);
    expect(mock.calls.detach).toContainEqual({ target: { tabId: TAB } });
    expect(mock.listenerCount()).toBe(0);
    // Data captured under an ended capability is not handed out.
    const snap = await stopCapture(TAB);
    expect(snap.entries).toEqual([]);
  });

  it("Chrome revoking the origin's grant ends an attached session at once", async () => {
    registerCaptureLifecycle();
    await attachDebugger(TAB);
    mock.revoke(`${A}/*`);
    await flush();
    expect(mock.calls.detach).toContainEqual({ target: { tabId: TAB } });
    expect(mock.listenerCount()).toBe(0);
    emitJson(mock, TAB, "r2", `${A}/proxy/api/clients`);
    await flush();
    expect(bodyReads(mock)).toHaveLength(0);
    // And no new handle can be created for it.
    await expect(attachDebugger(TAB)).rejects.toThrow(
      "capture_origin_not_granted",
    );
  });

  it("a body read that resolves after retirement lands nowhere", async () => {
    /** @type {((value: { body: string, base64Encoded: boolean }) => void) | undefined} */
    let release;
    mock.onCommand(
      "Network.getResponseBody",
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await attachDebugger(TAB);
    emitJson(mock, TAB, "r1", `${A}/proxy/api/clients`);
    await flush();
    const retiring = retireCaptureSessions();
    if (!release) throw new Error("body read never started");
    release({ body: '{"late":true}', base64Encoded: false });
    await retiring;
    expect((await stopCapture(TAB)).entries).toEqual([]);
  });
});

describe("A2 — the debugger never follows a navigation", () => {
  let mock;
  beforeEach(() => {
    mock = makeChromeMock();
    installChrome(mock);
    registerCaptureLifecycle();
    mock.onCommand("Network.getResponseBody", () => ({
      body: "{}",
      base64Encoded: false,
    }));
  });

  it("a navigation that lands during attach is caught: the handle is rolled back", async () => {
    // Chrome grants B too (a previous run), so a URL check alone would pass.
    mock.grant(`${B}/*`);
    const originalAttach = mock.chrome.debugger.attach;
    mock.chrome.debugger.attach = async (target, version) => {
      await originalAttach(target, version);
      mock.navigateTab(TAB, `${B}/landing`);
    };
    await expect(attachDebugger(TAB)).rejects.toThrow();
    expect(mock.calls.detach).toContainEqual({ target: { tabId: TAB } });
    expect(mock.listenerCount()).toBe(0);
  });

  it("tabs.onUpdated to another origin tears the session down, even a granted one", async () => {
    mock.grant(`${B}/*`);
    await attachDebugger(TAB);
    mock.navigateTab(TAB, `${B}/app`);
    await flush();
    expect(mock.calls.detach).toContainEqual({ target: { tabId: TAB } });
    expect(mock.listenerCount()).toBe(0);
    // Requests to A issued from the B document are not capturable.
    emitJson(mock, TAB, "r9", `${A}/proxy/api/clients`);
    await flush();
    expect(bodyReads(mock)).toHaveLength(0);
  });

  it("a same-origin navigation keeps the session", async () => {
    await attachDebugger(TAB);
    mock.navigateTab(TAB, `${A}/clients/42`);
    await flush();
    expect(mock.listenerCount()).toBe(1);
    await stopCapture(TAB);
  });

  it("a request issued by a foreign document (documentURL) detaches before any body read", async () => {
    await attachDebugger(TAB);
    emitJson(mock, TAB, "r1", `${A}/proxy/api/clients`, {
      documentURL: `${B}/page`,
    });
    await flush();
    expect(bodyReads(mock)).toHaveLength(0);
    expect(mock.calls.detach).toContainEqual({ target: { tabId: TAB } });
    const snap = await stopCapture(TAB);
    expect(snap.entries).toEqual([]);
  });
});
