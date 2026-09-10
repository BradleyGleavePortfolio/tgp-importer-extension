import { describe, it, expect, beforeEach } from "vitest";
import { makeChromeMock, installChrome } from "./helpers/chrome-mock.js";
import {
    attachDebugger,
    stopCapture,
    sourcePlatformFor,
    redactHeaders,
    redactUrl,
} from "../shared/capture.js";
import { byteSizeOf } from "../shared/capture-buffer.js";

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

describe("redactHeaders", () => {
    it("redacts Authorization, Cookie, and Set-Cookie case-insensitively", () => {
        const out = redactHeaders({
            authorization: "Bearer x",
            Cookie: "a=b",
            "set-cookie": "s=1",
            "content-type": "application/json",
        });
        expect(out.authorization).toBe("<redacted>");
        expect(out.Cookie).toBe("<redacted>");
        expect(out["set-cookie"]).toBe("<redacted>");
        expect(out["content-type"]).toBe("application/json");
    });

    it("returns an empty object for non-record input", () => {
        expect(redactHeaders(undefined)).toEqual({});
        expect(redactHeaders("nope")).toEqual({});
        expect(redactHeaders(null)).toEqual({});
    });

    it("leaves a header set with nothing sensitive untouched", () => {
        expect(redactHeaders({ "x-a": "1", "x-b": "2" })).toEqual({ "x-a": "1", "x-b": "2" });
    });
});

describe("redactUrl", () => {
    it("redacts every sensitive query key variant", () => {
        for (const key of ["token", "access_token", "id_token", "api_key", "api-key", "apikey"]) {
            const out = redactUrl(`https://x.co/p?${key}=secret&keep=1`);
            expect(out).toContain(`${key}=<redacted>`);
            expect(out).toContain("keep=1");
            expect(out).not.toContain("secret");
        }
    });

    it("preserves generic auth and session query labels with benign values", () => {
        const url = "https://x.co/p?auth=documentation&session=strength";
        expect(redactUrl(url)).toBe(url);
    });

    it("is case-insensitive on the query key", () => {
        expect(redactUrl("https://x.co/p?ACCESS_TOKEN=secret")).toContain("ACCESS_TOKEN=<redacted>");
    });

    it("returns the URL unchanged when no sensitive params are present", () => {
        const url = "https://x.co/p?page=2&sort=asc";
        expect(redactUrl(url)).toBe(url);
    });

    it("returns a URL with no query string unchanged", () => {
        expect(redactUrl("https://x.co/clients/42")).toBe("https://x.co/clients/42");
    });

    it("passes a malformed URL through unchanged", () => {
        expect(redactUrl("not a url?token=x")).toBe("not a url?token=x");
    });

    it("passes non-string input through unchanged", () => {
        expect(redactUrl(undefined)).toBeUndefined();
    });

    it("preserves the URL hash while redacting", () => {
        const out = redactUrl("https://x.co/p?token=secret#section");
        expect(out).toContain("token=<redacted>");
        expect(out).toContain("#section");
    });
});

describe("capture buffer overflow under load", () => {
    let mock;
    beforeEach(() => {
        mock = makeChromeMock();
        installChrome(mock);
    });

    it("evicts oldest captured entries once the byte cap is exceeded", async () => {
        // Each response body is ~2 KB; cap holds only a few entries.
        const body = `{"pad":"${"z".repeat(2000)}"}`;
        mock.onCommand("Network.getResponseBody", () => ({ body, base64Encoded: false }));
        const maxBytes = 7000;
        await attachDebugger(31, { maxBytes });
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
        // Eviction happened (fewer than the 6 pushed) but the newest survives.
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.length).toBeLessThan(6);
        const ids = entries.map((e) => e.requestId);
        expect(ids).not.toContain("q0");
        expect(ids[ids.length - 1]).toBe("q5");
        // The retained set honours the byte bound.
        const held = entries.reduce((sum, e) => sum + byteSizeOf(e), 0);
        expect(held).toBeLessThanOrEqual(maxBytes);
    });

    it("falls back to the default 5 MB cap when options.maxBytes is not a number", async () => {
        mock.onCommand("Network.getResponseBody", () => ({ body: "{}", base64Encoded: false }));
        await attachDebugger(32, { maxBytes: "big" });
        reqWillBeSent(mock, 32, "d1", "https://x.co/a.json", "GET", {});
        respReceived(mock, 32, "d1", "application/json", 200);
        loadingFinished(mock, 32, "d1");
        const entries = await stopCapture(32);
        // Attaching succeeds and the buffer captures normally under the default cap.
        expect(entries).toHaveLength(1);
    });

    it("uses encoded length to reject an oversized body before fetching it", async () => {
        await attachDebugger(33, { maxBytes: 100 });
        reqWillBeSent(mock, 33, "large", "https://x.co/large.json", "GET", {});
        respReceived(mock, 33, "large", "application/json", 200);
        mock.emit({ tabId: 33 }, "Network.loadingFinished", {
            requestId: "large", encodedDataLength: 101,
        });
        expect(await stopCapture(33)).toEqual([]);
        expect(mock.calls.sendCommand.filter((call) => call.method === "Network.getResponseBody"))
            .toHaveLength(0);
    });

    it("bounds pending requests and finalizers under a stalled response flood", async () => {
        const resolvers = [];
        mock.onCommand("Network.getResponseBody", () => new Promise((resolve) => resolvers.push(resolve)));
        await attachDebugger(34);
        for (let index = 0; index < 1002; index += 1) {
            const id = `pending-${index}`;
            reqWillBeSent(mock, 34, id, `https://x.co/${id}.json`, "GET", {});
            await Promise.resolve();
        }
        for (let index = 2; index < 1002; index += 1) {
            const id = `pending-${index}`;
            respReceived(mock, 34, id, "application/json", 200);
            await Promise.resolve();
            loadingFinished(mock, 34, id);
        }
        expect(resolvers).toHaveLength(1000);
        resolvers.forEach((resolve) => resolve({ body: "{}", base64Encoded: false }));
        expect(await stopCapture(34)).toHaveLength(1000);
    });
});
