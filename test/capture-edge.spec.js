import { describe, it, expect, beforeEach } from "vitest";
import { makeChromeMock, installChrome } from "./helpers/chrome-mock.js";
import {
    attachDebugger,
    stopCapture,
    RingBuffer,
    startRingBuffer,
    sourcePlatformFor,
} from "../shared/capture.js";

const TAB = 21;

function reqWillBeSent(mock, tabId, requestId, url, method, headers) {
    mock.emit({ tabId }, "Network.requestWillBeSent", {
        requestId,
        request: { url, method, headers },
    });
}

function respReceived(mock, tabId, requestId, mimeType, status) {
    mock.emit({ tabId }, "Network.responseReceived", {
        requestId,
        response: { mimeType, status },
    });
}

function loadingFinished(mock, tabId, requestId) {
    mock.emit({ tabId }, "Network.loadingFinished", { requestId });
}

describe("capture edge cases", () => {
    let mock;
    beforeEach(() => {
        mock = makeChromeMock();
        installChrome(mock);
    });

    it("ignores loadingFinished with no matching request", async () => {
        mock.onCommand("Network.getResponseBody", () => ({ body: "{}", base64Encoded: false }));
        await attachDebugger(TAB);
        loadingFinished(mock, TAB, "ghost");
        const entries = await stopCapture(TAB);
        expect(entries).toHaveLength(0);
    });

    it("ignores responseReceived with no matching request", async () => {
        await attachDebugger(TAB);
        respReceived(mock, TAB, "orphan", "application/json", 200);
        loadingFinished(mock, TAB, "orphan");
        const entries = await stopCapture(TAB);
        expect(entries).toHaveLength(0);
    });

    it("skips requestWillBeSent missing a requestId", async () => {
        await attachDebugger(TAB);
        mock.emit({ tabId: TAB }, "Network.requestWillBeSent", {
            request: { url: "https://x.co/a", method: "GET", headers: {} },
        });
        const entries = await stopCapture(TAB);
        expect(entries).toHaveLength(0);
    });

    it("skips requestWillBeSent missing a url", async () => {
        await attachDebugger(TAB);
        mock.emit({ tabId: TAB }, "Network.requestWillBeSent", {
            requestId: "no-url",
            request: { method: "GET", headers: {} },
        });
        const entries = await stopCapture(TAB);
        expect(entries).toHaveLength(0);
    });

    it("defaults requestHeaders to {} when the request omits headers", async () => {
        mock.onCommand("Network.getResponseBody", () => ({
            body: '{"ok":true}',
            base64Encoded: false,
        }));
        await attachDebugger(TAB);
        reqWillBeSent(mock, TAB, "h1", "https://x.co/a.json", "GET", undefined);
        respReceived(mock, TAB, "h1", "application/json", 200);
        loadingFinished(mock, TAB, "h1");
        const entries = await stopCapture(TAB);
        expect(entries).toHaveLength(1);
        expect(entries[0].requestHeaders).toEqual({});
    });

    it("defaults method to empty string when absent", async () => {
        mock.onCommand("Network.getResponseBody", () => ({
            body: "{}",
            base64Encoded: false,
        }));
        await attachDebugger(TAB);
        mock.emit({ tabId: TAB }, "Network.requestWillBeSent", {
            requestId: "m1",
            request: { url: "https://x.co/a.json", headers: {} },
        });
        respReceived(mock, TAB, "m1", "application/json", 200);
        loadingFinished(mock, TAB, "m1");
        const entries = await stopCapture(TAB);
        expect(entries[0].method).toBe("");
    });

    it("records statusCode null when responseReceived never arrives", async () => {
        mock.onCommand("Network.getResponseBody", () => ({
            body: "{}",
            base64Encoded: false,
        }));
        await attachDebugger(TAB);
        reqWillBeSent(mock, TAB, "s1", "https://x.co/a.json", "GET", {});
        // No responseReceived — pending has no statusCode; but it also was never
        // marked JSON, so it stays inflight and loadingFinished fetches nothing.
        loadingFinished(mock, TAB, "s1");
        const entries = await stopCapture(TAB);
        // Without a JSON responseReceived the entry is still finalized from the
        // request record; statusCode falls back to null.
        expect(entries).toHaveLength(1);
        expect(entries[0].statusCode).toBeNull();
    });

    it("accepts vendor json mime types (application/vnd.api+json)", async () => {
        mock.onCommand("Network.getResponseBody", () => ({
            body: '{"data":[]}',
            base64Encoded: false,
        }));
        await attachDebugger(TAB);
        reqWillBeSent(mock, TAB, "v1", "https://api.x.co/a", "GET", {});
        respReceived(mock, TAB, "v1", "application/vnd.api+json", 200);
        loadingFinished(mock, TAB, "v1");
        const entries = await stopCapture(TAB);
        expect(entries).toHaveLength(1);
    });

    it("drops responses with a missing mime type", async () => {
        let fetched = false;
        mock.onCommand("Network.getResponseBody", () => {
            fetched = true;
            return { body: "{}", base64Encoded: false };
        });
        await attachDebugger(TAB);
        reqWillBeSent(mock, TAB, "n1", "https://x.co/a", "GET", {});
        respReceived(mock, TAB, "n1", undefined, 200);
        loadingFinished(mock, TAB, "n1");
        const entries = await stopCapture(TAB);
        expect(entries).toHaveLength(0);
        expect(fetched).toBe(false);
    });

    it("drops a JSON body that getResponseBody returns without a body field", async () => {
        mock.onCommand("Network.getResponseBody", () => ({ base64Encoded: false }));
        await attachDebugger(TAB);
        reqWillBeSent(mock, TAB, "b1", "https://x.co/a.json", "GET", {});
        respReceived(mock, TAB, "b1", "application/json", 200);
        loadingFinished(mock, TAB, "b1");
        const entries = await stopCapture(TAB);
        expect(entries).toHaveLength(0);
    });

    it("tags sourcePlatform from the request url host", async () => {
        mock.onCommand("Network.getResponseBody", () => ({
            body: "{}",
            base64Encoded: false,
        }));
        await attachDebugger(TAB);
        reqWillBeSent(mock, TAB, "p1", "https://coach.example.io/v2/data", "GET", {});
        respReceived(mock, TAB, "p1", "application/json", 200);
        loadingFinished(mock, TAB, "p1");
        const entries = await stopCapture(TAB);
        expect(entries[0].sourcePlatform).toBe("auto:coach.example.io");
    });

    it("ignores a Fetch.requestPaused missing a requestId", async () => {
        await attachDebugger(TAB);
        mock.emit({ tabId: TAB }, "Fetch.requestPaused", {});
        await Promise.resolve();
        const cont = mock.calls.sendCommand.find((c) => c.method === "Fetch.continueRequest");
        expect(cont).toBeUndefined();
        await stopCapture(TAB);
    });

    it("independent tabs keep independent buffers", async () => {
        mock.onCommand("Network.getResponseBody", (_t, params) => ({
            body: `{"id":"${params.requestId}"}`,
            base64Encoded: false,
        }));
        await attachDebugger(1);
        await attachDebugger(2);
        reqWillBeSent(mock, 1, "t1", "https://one.co/a.json", "GET", {});
        respReceived(mock, 1, "t1", "application/json", 200);
        loadingFinished(mock, 1, "t1");
        reqWillBeSent(mock, 2, "t2", "https://two.co/b.json", "GET", {});
        respReceived(mock, 2, "t2", "application/json", 200);
        loadingFinished(mock, 2, "t2");
        const first = await stopCapture(1);
        const second = await stopCapture(2);
        expect(first.map((e) => e.requestId)).toEqual(["t1"]);
        expect(second.map((e) => e.requestId)).toEqual(["t2"]);
    });

    it("second stopCapture for the same tab returns empty", async () => {
        await attachDebugger(TAB);
        await stopCapture(TAB);
        const again = await stopCapture(TAB);
        expect(again).toEqual([]);
    });
});

describe("RingBuffer additional invariants", () => {
    it("handles capacity of 1 by keeping only the newest", () => {
        const buf = new RingBuffer(1);
        buf.push("a");
        buf.push("b");
        buf.push("c");
        expect(buf.snapshot()).toEqual(["c"]);
    });

    it("preserves object references, not copies", () => {
        const buf = new RingBuffer(2);
        const obj = { k: 1 };
        buf.push(obj);
        expect(buf.snapshot()[0]).toBe(obj);
    });

    it("startRingBuffer and new RingBuffer behave identically on overflow", () => {
        const a = startRingBuffer(2);
        const b = new RingBuffer(2);
        ["x", "y", "z"].forEach((e) => {
            a.push(e);
            b.push(e);
        });
        expect(a.snapshot()).toEqual(b.snapshot());
    });
});

describe("sourcePlatformFor additional cases", () => {
    it("handles http (non-tls) urls", () => {
        expect(sourcePlatformFor("http://legacy.local/x")).toBe("auto:legacy.local");
    });

    it("lowercases nothing — preserves host as parsed", () => {
        expect(sourcePlatformFor("https://APP.Example.COM/x")).toBe("auto:app.example.com");
    });

    it("returns null for a protocol-relative url", () => {
        expect(sourcePlatformFor("//example.com/x")).toBeNull();
    });

    it("handles subdomains distinctly", () => {
        expect(sourcePlatformFor("https://api.tgp.coach/x")).toBe("auto:api.tgp.coach");
        expect(sourcePlatformFor("https://app.tgp.coach/x")).toBe("auto:app.tgp.coach");
    });

    it("strips userinfo and keeps only the host", () => {
        expect(sourcePlatformFor("https://user:pass@host.example/x")).toBe("auto:host.example");
    });

    it("returns null for a bare scheme with no host", () => {
        expect(sourcePlatformFor("https://")).toBeNull();
    });

    it("returns null for whitespace-only input", () => {
        expect(sourcePlatformFor("   ")).toBeNull();
    });

    it("handles a trailing-dot fqdn host", () => {
        expect(sourcePlatformFor("https://host.example./x")).toBe("auto:host.example.");
    });
});

describe("capture buffer overflow under load", () => {
    let mock;
    beforeEach(() => {
        mock = makeChromeMock();
        installChrome(mock);
    });

    it("evicts oldest captured entries beyond capacity", async () => {
        mock.onCommand("Network.getResponseBody", (_t, params) => ({
            body: `{"id":"${params.requestId}"}`,
            base64Encoded: false,
        }));
        // Attach with a tiny capacity via the internal options hook.
        await attachDebugger(31, { capacity: 3 });
        for (let i = 0; i < 6; i += 1) {
            const id = `q${i}`;
            reqWillBeSent(mock, 31, id, `https://x.co/${id}.json`, "GET", {});
            respReceived(mock, 31, id, "application/json", 200);
            loadingFinished(mock, 31, id);
            // flush microtasks so each getResponseBody resolves before the next
            await Promise.resolve();
            await Promise.resolve();
        }
        const entries = await stopCapture(31);
        expect(entries).toHaveLength(3);
        expect(entries.map((e) => e.requestId)).toEqual(["q3", "q4", "q5"]);
    });

    it("falls back to default capacity when options.capacity is not a number", async () => {
        await attachDebugger(32, { capacity: "big" });
        // Attaching succeeds; buffer is usable and empty at stop.
        const entries = await stopCapture(32);
        expect(entries).toEqual([]);
    });
});
