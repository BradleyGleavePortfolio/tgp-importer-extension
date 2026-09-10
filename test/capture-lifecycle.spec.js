import { describe, it, expect, beforeEach } from "vitest";
import { makeChromeMock, installChrome } from "./helpers/chrome-mock.js";
import {
  attachDebugger,
  stopCapture,
  registerCaptureLifecycle,
} from "../shared/capture.js";

// Let the async void teardownSession settle (drains finalizers, then detach).
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("capture lifecycle cleanup", () => {
  let mock;
  beforeEach(() => {
    mock = makeChromeMock();
    installChrome(mock);
    registerCaptureLifecycle();
  });

  it("releases the session and detaches when the captured tab is removed", async () => {
    await attachDebugger(50);
    expect(mock.listenerCount()).toBe(1);
    mock.emitTabRemoved(50);
    await flush();
    expect(mock.listenerCount()).toBe(0);
    expect(mock.calls.detach).toContainEqual({ target: { tabId: 50 } });
    expect(await stopCapture(50)).toEqual([]);
  });

  it("releases the session without a redundant detach when Chrome detaches it", async () => {
    await attachDebugger(51);
    mock.emitDetach({ tabId: 51, reason: "canceled_by_user" });
    await flush();
    expect(mock.listenerCount()).toBe(0);
    // Chrome already detached — the onDetach path must not re-issue detach.
    expect(mock.calls.detach).toEqual([]);
    expect(await stopCapture(51)).toEqual([]);
  });

  it("ignores a detach event that carries no numeric tabId", async () => {
    await attachDebugger(52);
    mock.emitDetach({ reason: "target_closed" });
    await flush();
    // An unrelated detach must not tear down the active session.
    expect(mock.listenerCount()).toBe(1);
    await stopCapture(52);
  });

  it("tears down every active session on service-worker suspend", async () => {
    await attachDebugger(60);
    await attachDebugger(61);
    expect(mock.listenerCount()).toBe(2);
    mock.emitSuspend();
    await flush();
    expect(mock.listenerCount()).toBe(0);
    expect(await stopCapture(60)).toEqual([]);
    expect(await stopCapture(61)).toEqual([]);
  });

  it("tab-close cleanup drains an in-flight finalizer before releasing", async () => {
    let resolveBody;
    mock.onCommand(
      "Network.getResponseBody",
      () =>
        new Promise((resolve) => {
          resolveBody = resolve;
        }),
    );
    await attachDebugger(70);
    mock.emit({ tabId: 70 }, "Network.requestWillBeSent", {
      requestId: "x",
      request: { url: "https://x.co/a.json", method: "GET", headers: {} },
    });
    mock.emit({ tabId: 70 }, "Network.responseReceived", {
      requestId: "x",
      response: { mimeType: "application/json", status: 200 },
    });
    mock.emit({ tabId: 70 }, "Network.loadingFinished", { requestId: "x" });
    mock.emitTabRemoved(70);
    resolveBody({ body: "{}", base64Encoded: false });
    await flush();
    expect(mock.listenerCount()).toBe(0);
    expect(await stopCapture(70)).toEqual([]);
  });

  it("cleanup for an untracked tab is a harmless no-op", async () => {
    mock.emitTabRemoved(9999);
    await flush();
    expect(mock.calls.detach).toEqual([]);
  });
});
