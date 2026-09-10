import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeChromeMock, installChrome } from "./helpers/chrome-mock.js";
import { attachDebugger, stopCapture } from "../shared/capture.js";
import { normalizeCaptureSnapshot } from "../shared/blueprint/input.js";
import { inferUrlTemplates } from "../shared/blueprint/url-templates.js";
import { clusterResponseShapes } from "../shared/blueprint/shapes.js";

// Replay a recorded CDP trace against the real capture pipeline. Each fixture
// carries the exact Network.* events Chrome emits plus the Network.getResponseBody
// reply, so these tests exercise capture.js against payload shapes the browser
// actually produces — not hand-rolled synthetic stubs.
function loadTrace(name) {
    const path = fileURLToPath(new URL(`./fixtures/cdp-traces/${name}`, import.meta.url));
    return JSON.parse(readFileSync(path, "utf8"));
}

// Drive one fixture's events through the mock, wiring getResponseBody to the
// recorded body keyed by requestId.
function replay(mock, trace) {
    mock.onCommand("Network.getResponseBody", (_t, params) => {
        if (params.requestId === trace.responseBody.requestId) {
            return { body: trace.responseBody.body, base64Encoded: trace.responseBody.base64Encoded };
        }
        throw new Error(`no recorded body for ${params.requestId}`);
    });
    for (const evt of trace.events) {
        mock.emit({ tabId: trace.tabId }, evt.method, evt.params);
    }
}

describe("capture replays real CDP traces", () => {
    let mock;
    beforeEach(() => {
        mock = makeChromeMock();
        installChrome(mock);
    });

    it("captures a JSON API response from a recorded TrueCoach clients trace", async () => {
        const trace = loadTrace("truecoach-clients.json");
        await attachDebugger(trace.tabId);
        replay(mock, trace);
        const [entry, ...rest] = await stopCapture(trace.tabId);
        expect(rest).toHaveLength(0);
        expect(entry.requestId).toBe("39145.42");
        expect(entry.method).toBe("GET");
        expect(entry.statusCode).toBe(200);
        expect(entry.responseBody).toBe(trace.responseBody.body);
        expect(entry.sourcePlatform).toBe("auto:app.truecoach.co");
    });

    it("redacts sensitive headers and URL tokens from the recorded trace", async () => {
        const trace = loadTrace("truecoach-clients.json");
        await attachDebugger(trace.tabId);
        replay(mock, trace);
        const [entry] = await stopCapture(trace.tabId);
        expect(entry.requestHeaders.Authorization).toBe("<redacted>");
        expect(entry.requestHeaders.Cookie).toBe("<redacted>");
        expect(entry.requestHeaders.Accept).toBe("application/json, text/plain, */*");
        expect(entry.url).toContain("access_token=<redacted>");
        expect(entry.url).not.toContain("eyJraWQ");
    });

    it("drives the provenance-stamped TrueCoach trace through the real C1 to C2a seam", async () => {
        const trace = loadTrace("truecoach-clients.json");
        await attachDebugger(trace.tabId);
        replay(mock, trace);
        const captured = await stopCapture(trace.tabId);
        const normalized = normalizeCaptureSnapshot(captured);
        expect(normalized.excluded).toEqual([]);
        expect(normalized.observations).toHaveLength(1);
        expect(inferUrlTemplates(normalized.observations)).toEqual({
            clusters: [{
                origin: "https://app.truecoach.co",
                method: "GET",
                pathPattern: "/proxy/api/clients",
                dynamicSegments: 0,
                replayCompatible: true,
                queryKeys: ["page"],
                observations: 1,
            }],
            excluded: [],
        });
        expect(clusterResponseShapes(normalized.observations, { maxDepth: 3 })).toEqual([{
            origin: "https://app.truecoach.co",
            method: "GET",
            signature: "object{clients:array[object{email:string,id:number,name:string}],page:number,total:number}",
            observations: 1,
        }]);
    });

    it("drops a recorded text/html document trace at the header stage", async () => {
        const trace = loadTrace("truecoach-html-page.json");
        let bodyFetched = false;
        mock.onCommand("Network.getResponseBody", () => {
            bodyFetched = true;
            return { body: trace.responseBody.body, base64Encoded: false };
        });
        await attachDebugger(trace.tabId);
        for (const evt of trace.events) {
            mock.emit({ tabId: trace.tabId }, evt.method, evt.params);
        }
        const entries = await stopCapture(trace.tabId);
        expect(entries).toHaveLength(0);
        expect(bodyFetched).toBe(false);
    });
});
