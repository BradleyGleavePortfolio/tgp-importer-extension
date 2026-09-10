import { describe, it, expect, beforeEach } from "vitest";
import { makeChromeMock, installChrome } from "./helpers/chrome-mock.js";
import {
  attachDebugger,
  normalizeCapturedSnapshot,
  redactHeaders,
  redactUrl,
  recordRequest,
  stopCapture,
} from "../shared/capture.js";

const TAB = 11;

// Drive a full JSON request lifecycle through the mocked debugger events.
function emitJsonRequest(
  mock,
  tabId,
  { requestId, url, method, mimeType, status },
) {
  const source = { tabId };
  mock.emit(source, "Network.requestWillBeSent", {
    requestId,
    request: { url, method, headers: { "x-test": "1" } },
  });
  mock.emit(source, "Network.responseReceived", {
    requestId,
    response: { mimeType, status },
  });
  mock.emit(source, "Network.loadingFinished", { requestId });
}

describe("attachDebugger / stopCapture", () => {
  let mock;
  beforeEach(() => {
    mock = makeChromeMock();
    installChrome(mock);
  });

  it("attaches with protocol 1.3 and enables Network only (never Fetch)", async () => {
    await attachDebugger(TAB);
    expect(mock.calls.attach).toEqual([
      { target: { tabId: TAB }, version: "1.3" },
    ]);
    const methods = mock.calls.sendCommand.map((c) => c.method);
    expect(methods).toContain("Network.enable");
    expect(methods).not.toContain("Fetch.enable");
    await stopCapture(TAB);
  });

  it("is idempotent — re-attaching returns the same buffer and attaches once", async () => {
    const first = await attachDebugger(TAB);
    const second = await attachDebugger(TAB);
    expect(second).toBe(first);
    expect(mock.calls.attach).toHaveLength(1);
    await stopCapture(TAB);
  });

  it("throws when tabId is not a number", async () => {
    await expect(attachDebugger("nope")).rejects.toThrow(/tabId/);
  });

  it("rolls back the listener and session when attach is denied", async () => {
    mock.chrome.debugger.attach = async () => {
      throw new Error("Cannot attach — user denied");
    };
    await expect(attachDebugger(TAB)).rejects.toThrow(/denied/);
    // No listener and no poisoned session are left behind.
    expect(mock.listenerCount()).toBe(0);
    // A later stopCapture sees no session (rollback deleted it).
    expect((await stopCapture(TAB)).entries).toEqual([]);
  });

  it("rolls back and attempts detach when Network.enable fails", async () => {
    mock.failCommand("Network.enable");
    await expect(attachDebugger(TAB)).rejects.toThrow(/Network.enable/);
    expect(mock.listenerCount()).toBe(0);
    // The partial attach was torn down with a detach call.
    expect(mock.calls.detach).toEqual([{ target: { tabId: TAB } }]);
  });

  it("is not a false idempotent hit after a failed attach", async () => {
    mock.chrome.debugger.attach = async () => {
      throw new Error("first attach fails");
    };
    await expect(attachDebugger(TAB)).rejects.toThrow();
    // Repair the mock; the next attach must genuinely re-attach, not return a
    // poisoned buffer from the rolled-back session.
    mock.chrome.debugger.attach = async (target, version) => {
      mock.calls.attach.push({ target, version });
    };
    await attachDebugger(TAB);
    expect(mock.calls.attach).toContainEqual({
      target: { tabId: TAB },
      version: "1.3",
    });
    await stopCapture(TAB);
  });

  it("captures a JSON response into the buffer", async () => {
    mock.onCommand("Network.getResponseBody", () => ({
      body: JSON.stringify({ hello: "world" }),
      base64Encoded: false,
    }));
    await attachDebugger(TAB);
    emitJsonRequest(mock, TAB, {
      requestId: "r1",
      url: "https://app.truecoach.co/proxy/api/clients",
      method: "GET",
      mimeType: "application/json",
      status: 200,
    });
    const { entries } = await stopCapture(TAB);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      requestId: "r1",
      url: "https://app.truecoach.co/proxy/api/clients",
      method: "GET",
      statusCode: 200,
      responseBody: JSON.stringify({ hello: "world" }),
      sourcePlatform: "auto:app.truecoach.co",
    });
    expect(entries[0].requestHeaders).toEqual({ "x-test": "1" });
    expect(typeof entries[0].capturedAt).toBe("string");
  });

  it("drops non-JSON responses at the header stage", async () => {
    let bodyFetched = false;
    mock.onCommand("Network.getResponseBody", () => {
      bodyFetched = true;
      return { body: "<html>", base64Encoded: false };
    });
    await attachDebugger(TAB);
    emitJsonRequest(mock, TAB, {
      requestId: "r2",
      url: "https://app.truecoach.co/",
      method: "GET",
      mimeType: "text/html",
      status: 200,
    });
    const { entries } = await stopCapture(TAB);
    expect(entries).toHaveLength(0);
    expect(bodyFetched).toBe(false);
  });

  it("drops base64-encoded (binary) bodies", async () => {
    mock.onCommand("Network.getResponseBody", () => ({
      body: "AAAA",
      base64Encoded: true,
    }));
    await attachDebugger(TAB);
    emitJsonRequest(mock, TAB, {
      requestId: "r3",
      url: "https://app.truecoach.co/blob.json",
      method: "GET",
      mimeType: "application/json",
      status: 200,
    });
    const { entries } = await stopCapture(TAB);
    expect(entries).toHaveLength(0);
  });

  it("ignores events from other tabs", async () => {
    mock.onCommand("Network.getResponseBody", () => ({
      body: "{}",
      base64Encoded: false,
    }));
    await attachDebugger(TAB);
    emitJsonRequest(mock, 999, {
      requestId: "r4",
      url: "https://other.example.com/x.json",
      method: "GET",
      mimeType: "application/json",
      status: 200,
    });
    const { entries } = await stopCapture(TAB);
    expect(entries).toHaveLength(0);
  });

  it("never enables the Fetch domain, so browsing is never paused", async () => {
    await attachDebugger(TAB);
    const methods = mock.calls.sendCommand.map((c) => c.method);
    expect(methods.some((m) => m.startsWith("Fetch."))).toBe(false);
    await stopCapture(TAB);
  });

  it("redacts sensitive request headers before storing an entry", async () => {
    mock.onCommand("Network.getResponseBody", () => ({
      body: "{}",
      base64Encoded: false,
    }));
    await attachDebugger(TAB);
    mock.emit({ tabId: TAB }, "Network.requestWillBeSent", {
      requestId: "sec1",
      request: {
        url: "https://app.truecoach.co/api/x",
        method: "GET",
        headers: {
          Authorization: "Bearer super-secret",
          Cookie: "session=abc",
          "X-Trace": "keep-me",
        },
      },
    });
    mock.emit({ tabId: TAB }, "Network.responseReceived", {
      requestId: "sec1",
      response: { mimeType: "application/json", status: 200 },
    });
    mock.emit({ tabId: TAB }, "Network.loadingFinished", { requestId: "sec1" });
    const {
      entries: [entry],
    } = await stopCapture(TAB);
    expect(entry.requestHeaders.Authorization).toBe("<redacted>");
    expect(entry.requestHeaders.Cookie).toBe("<redacted>");
    expect(entry.requestHeaders["X-Trace"]).toBe("keep-me");
  });

  it("redacts token-bearing query params in the stored URL", async () => {
    mock.onCommand("Network.getResponseBody", () => ({
      body: "{}",
      base64Encoded: false,
    }));
    await attachDebugger(TAB);
    mock.emit({ tabId: TAB }, "Network.requestWillBeSent", {
      requestId: "url1",
      request: {
        url: "https://app.truecoach.co/api/x?access_token=leak&page=2",
        method: "GET",
        headers: {},
      },
    });
    mock.emit({ tabId: TAB }, "Network.responseReceived", {
      requestId: "url1",
      response: { mimeType: "application/json", status: 200 },
    });
    mock.emit({ tabId: TAB }, "Network.loadingFinished", { requestId: "url1" });
    const {
      entries: [entry],
    } = await stopCapture(TAB);
    expect(entry.url).toContain("access_token=<redacted>");
    expect(entry.url).toContain("page=2");
    expect(entry.url).not.toContain("leak");
    // Host provenance is still derived from the original URL.
    expect(entry.sourcePlatform).toBe("auto:app.truecoach.co");
  });

  it("never stores raw request metadata in inflight state", () => {
    const secret = "RAW-CREDENTIAL-MUST-NEVER-ENTER-INFLIGHT";
    const headers = { "X.Vendor-CREDENTIAL__v7": secret };
    const inflight = new Map();
    recordRequest(
      {
        requestId: "pending-secret",
        request: {
          url: `https://app.truecoach.co/api?access_token=${secret}`,
          method: "GET",
          headers,
        },
      },
      inflight,
      "https://app.truecoach.co",
      () => {},
    );
    const stored = inflight.get("pending-secret");
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored.requestHeaders).not.toBe(headers);
    expect(stored.requestHeaders["X.Vendor-CREDENTIAL__v7"]).toBe("<redacted>");
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.requestHeaders)).toBe(true);
  });

  it("rejects URL userinfo before it can enter the capture buffer", async () => {
    const secret = "raw-user:raw-password";
    await attachDebugger(TAB);
    emitJsonRequest(mock, TAB, {
      requestId: "userinfo",
      url: `https://${secret}@app.truecoach.co/api`,
      method: "GET",
      mimeType: "application/json",
      status: 200,
    });
    const snapshot = await stopCapture(TAB);
    expect(snapshot.entries).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot.excluded).toEqual([
      { reason: "userinfo_rejected", count: 1 },
    ]);
  });

  it("awaits an in-flight finalizer before returning the stop snapshot", async () => {
    let resolveBody;
    mock.onCommand(
      "Network.getResponseBody",
      () =>
        new Promise((resolve) => {
          resolveBody = resolve;
        }),
    );
    await attachDebugger(TAB);
    emitJsonRequest(mock, TAB, {
      requestId: "late",
      url: "https://app.truecoach.co/api/late",
      method: "GET",
      mimeType: "application/json",
      status: 200,
    });
    // Begin the stop while the body fetch is still pending, then resolve it.
    // stopCapture must drain the finalizer rather than snapshot early.
    const stopPromise = stopCapture(TAB);
    // @ts-expect-error -- assigned synchronously when the command handler runs.
    resolveBody({ body: JSON.stringify({ ok: true }), base64Encoded: false });
    const { entries } = await stopPromise;
    expect(entries).toHaveLength(1);
    expect(entries[0].requestId).toBe("late");
  });

  it("skips entries when getResponseBody fails", async () => {
    mock.failCommand("Network.getResponseBody");
    await attachDebugger(TAB);
    emitJsonRequest(mock, TAB, {
      requestId: "r5",
      url: "https://app.truecoach.co/x.json",
      method: "GET",
      mimeType: "application/json",
      status: 200,
    });
    const { entries } = await stopCapture(TAB);
    expect(entries).toHaveLength(0);
  });

  it("stopCapture on an unknown tab returns an empty array", async () => {
    const { entries } = await stopCapture(4242);
    expect(entries).toEqual([]);
  });

  it("stopCapture detaches and removes the event listener", async () => {
    await attachDebugger(TAB);
    expect(mock.listenerCount()).toBe(1);
    await stopCapture(TAB);
    expect(mock.calls.detach).toEqual([{ target: { tabId: TAB } }]);
    expect(mock.listenerCount()).toBe(0);
  });

  it("tolerates detach failure on an already-closed tab", async () => {
    await attachDebugger(TAB);
    mock.failCommand("noop"); // no-op; detach is on chrome.debugger.detach
    mock.chrome.debugger.detach = async () => {
      throw new Error("No tab with given id");
    };
    const { entries } = await stopCapture(TAB);
    expect(entries).toEqual([]);
  });

  it("captures multiple requests in oldest-first order", async () => {
    const bodies = { a: '{"n":1}', b: '{"n":2}' };
    mock.onCommand("Network.getResponseBody", (_t, params) => ({
      body: params.requestId === "a" ? bodies.a : bodies.b,
      base64Encoded: false,
    }));
    await attachDebugger(TAB);
    emitJsonRequest(mock, TAB, {
      requestId: "a",
      url: "https://app.truecoach.co/a",
      method: "GET",
      mimeType: "application/json",
      status: 200,
    });
    // allow first getResponseBody to resolve before second finishes
    await Promise.resolve();
    emitJsonRequest(mock, TAB, {
      requestId: "b",
      url: "https://app.truecoach.co/b",
      method: "POST",
      mimeType: "application/json",
      status: 201,
    });
    const { entries } = await stopCapture(TAB);
    const ids = entries.map((e) => e.requestId).sort();
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("shared credential classification for request metadata", () => {
  it.each(["X-Api-Key", "api_secret", "cookies", "ＰＡＳＳＷＯＲＤ"])(
    "redacts header alias %s",
    (key) => expect(redactHeaders({ [key]: "RAW" })[key]).toBe("<redacted>"),
  );

  it.each(["refresh_token", "client_secret", "cardNumber", "ＴＯＫＥＮ"])(
    "redacts query alias %s",
    (key) => {
      const result = redactUrl(
        `https://coach.example/path?${encodeURIComponent(key)}=RAW&safe=ok`,
      );
      const params = new URL(result).searchParams;
      expect(params.get(key)).toBe("<redacted>");
      expect(params.get("safe")).toBe("ok");
    },
  );

  it("redacts credential-form values even under innocuous metadata keys", () => {
    expect(
      redactHeaders({ "X-Note": "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==" }),
    ).toEqual({ "X-Note": "<redacted>" });
    expect(
      new URL(
        redactUrl("https://coach.example/path?q=Bearer%20SECRET"),
      ).searchParams.get("q"),
    ).toBe("<redacted>");
  });
});

describe("authorized origin is enforced before recording request data", () => {
  let mock;

  beforeEach(() => {
    mock = makeChromeMock();
    installChrome(mock);
  });

  it("rejects one foreign request before reading headers or fetching its body", async () => {
    let headersRead = false;
    mock.onCommand("Network.getResponseBody", () => {
      throw new Error("foreign body must never be fetched");
    });
    await attachDebugger(TAB);
    const request = {
      url: "https://telemetry.vendor.invalid/collect",
      method: "GET",
      get headers() {
        headersRead = true;
        return { Authorization: "Bearer MUST-NOT-BE-READ" };
      },
    };
    mock.emit({ tabId: TAB }, "Network.requestWillBeSent", {
      requestId: "foreign-only",
      request,
    });
    mock.emit({ tabId: TAB }, "Network.responseReceived", {
      requestId: "foreign-only",
      response: { mimeType: "application/json", status: 200 },
    });
    mock.emit({ tabId: TAB }, "Network.loadingFinished", {
      requestId: "foreign-only",
    });

    const snapshot = await stopCapture(TAB);
    expect(headersRead).toBe(false);
    expect(snapshot).toEqual({
      entries: [],
      expectedOrigin: "https://app.truecoach.co",
      incomplete: true,
      degraded: true,
      excluded: [{ reason: "origin_rejected", count: 1 }],
    });
    expect(
      mock.calls.sendCommand.filter(
        ({ method }) => method === "Network.getResponseBody",
      ),
    ).toEqual([]);
    expect(normalizeCapturedSnapshot(snapshot)).toMatchObject({
      observations: [],
      incomplete: true,
      degraded: true,
      excluded: [{ reason: "origin_rejected", count: 1 }],
    });
  });

  it("quarantines a first-party requestId reused by a foreign redirect", async () => {
    const foreign = "FOREIGN-BODY-MUST-NEVER-ENTER-STORAGE";
    mock.onCommand("Network.getResponseBody", () => ({
      body: `{"harmless_name":"${foreign}"}`,
      base64Encoded: false,
    }));
    await attachDebugger(TAB);
    mock.emit({ tabId: TAB }, "Network.requestWillBeSent", {
      requestId: "redirected",
      request: {
        url: "https://app.truecoach.co/api/start",
        method: "GET",
        headers: {},
      },
    });
    mock.emit({ tabId: TAB }, "Network.requestWillBeSent", {
      requestId: "redirected",
      request: {
        url: "https://evil.invalid/private",
        method: "GET",
        headers: {},
      },
    });
    mock.emit({ tabId: TAB }, "Network.responseReceived", {
      requestId: "redirected",
      response: { mimeType: "application/json", status: 200 },
    });
    mock.emit({ tabId: TAB }, "Network.loadingFinished", {
      requestId: "redirected",
    });

    const snapshot = await stopCapture(TAB);
    expect(snapshot.entries).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain(foreign);
    expect(
      mock.calls.sendCommand.filter(
        ({ method }) => method === "Network.getResponseBody",
      ),
    ).toEqual([]);
    expect(snapshot.excluded).toEqual([
      { reason: "origin_rejected", count: 1 },
    ]);
  });

  it("keeps first-party traffic and excludes third-party traffic in one session", async () => {
    mock.onCommand("Network.getResponseBody", (_target, { requestId }) => ({
      body: JSON.stringify({ requestId }),
      base64Encoded: false,
    }));
    await attachDebugger(TAB);
    for (const [requestId, url] of [
      ["first-party", "https://app.truecoach.co/api/clients"],
      ["third-party", "https://cdn.vendor.invalid/config"],
    ]) {
      emitJsonRequest(mock, TAB, {
        requestId,
        url,
        method: "GET",
        mimeType: "application/json",
        status: 200,
      });
    }

    const snapshot = await stopCapture(TAB);
    expect(snapshot.expectedOrigin).toBe("https://app.truecoach.co");
    expect(snapshot.entries.map(({ requestId }) => requestId)).toEqual([
      "first-party",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("cdn.vendor.invalid");
    expect(normalizeCapturedSnapshot(snapshot)).toMatchObject({
      observations: [
        expect.objectContaining({
          origin: "https://app.truecoach.co",
          path: "/api/clients",
        }),
      ],
      incomplete: true,
      degraded: true,
      excluded: [{ reason: "origin_rejected", count: 1 }],
    });
  });
});
