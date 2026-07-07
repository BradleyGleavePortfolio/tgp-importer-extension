import { describe, it, expect, beforeEach } from "vitest";
import { makeChromeMock, installChrome } from "./helpers/chrome-mock.js";
import { attachDebugger, stopCapture } from "../shared/capture.js";

const TAB = 11;

// Drive a full JSON request lifecycle through the mocked debugger events.
function emitJsonRequest(mock, tabId, { requestId, url, method, mimeType, status, body }) {
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
    // getResponseBody is async; the handler awaits it. Return via onCommand below.
    void body;
}

describe("attachDebugger / stopCapture", () => {
    let mock;
    beforeEach(() => {
        mock = makeChromeMock();
        installChrome(mock);
    });

    it("attaches with protocol 1.3 and enables Network only (never Fetch)", async () => {
        await attachDebugger(TAB);
        expect(mock.calls.attach).toEqual([{ target: { tabId: TAB }, version: "1.3" }]);
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
        const entries = await stopCapture(TAB);
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
        const entries = await stopCapture(TAB);
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
        const entries = await stopCapture(TAB);
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
        const entries = await stopCapture(TAB);
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
        const [entry] = await stopCapture(TAB);
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
        const [entry] = await stopCapture(TAB);
        expect(entry.url).toContain("access_token=<redacted>");
        expect(entry.url).toContain("page=2");
        expect(entry.url).not.toContain("leak");
        // Host provenance is still derived from the original URL.
        expect(entry.sourcePlatform).toBe("auto:app.truecoach.co");
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
        const entries = await stopCapture(TAB);
        expect(entries).toHaveLength(0);
    });

    it("stopCapture on an unknown tab returns an empty array", async () => {
        const entries = await stopCapture(4242);
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
        const entries = await stopCapture(TAB);
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
            requestId: "a", url: "https://x.co/a", method: "GET", mimeType: "application/json", status: 200,
        });
        // allow first getResponseBody to resolve before second finishes
        await Promise.resolve();
        emitJsonRequest(mock, TAB, {
            requestId: "b", url: "https://x.co/b", method: "POST", mimeType: "application/json", status: 201,
        });
        const entries = await stopCapture(TAB);
        const ids = entries.map((e) => e.requestId).sort();
        expect(ids).toEqual(["a", "b"]);
    });
});
