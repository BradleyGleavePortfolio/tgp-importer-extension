// Layer 1 passive capture for the TGP Importer (see docs/AUTO_DISCOVERY.md §6).
//
// Attaches chrome.debugger to a tab, enables the Network + Fetch domains, and
// records JSON responses into a bounded ring buffer tagged with a
// `auto:<hostname>` source-platform provenance marker. Fetch is enabled only so
// that we can immediately continue every paused request — we never block the
// tab's own browsing; capture happens via the Network domain events.
//
// R75: zero banned type-assertions — every narrowing is a real guard.
// R76: this file stays comfortably under 400 LOC.

import { CaptureBuffer, DEFAULT_MAX_BYTES } from "./capture-buffer.js";

const DEBUGGER_PROTOCOL_VERSION = "1.3";

// Per-tab capture state, keyed by tabId. Each entry owns its own ring buffer,
// inflight-request table, and the debugger event listener used to tear down.
const sessions = new Map();

function isRecord(value) {
    return typeof value === "object" && value !== null;
}

function readString(record, key) {
    return isRecord(record) && typeof record[key] === "string" ? record[key] : null;
}

// ---- source-platform inference ----------------------------------------------

// Returns `auto:<hostname>` provenance for a URL, or null when the URL is
// malformed. Mirrors extractors/detect.js hostnameOf semantics.
function sourcePlatformFor(url) {
    if (typeof url !== "string" || url.length === 0) {
        return null;
    }
    try {
        const { hostname } = new URL(url);
        return hostname.length > 0 ? `auto:${hostname}` : null;
    }
    catch {
        return null;
    }
}

// ---- CDP payload guards -----------------------------------------------------

function readNestedString(record, outerKey, innerKey) {
    return isRecord(record) && isRecord(record[outerKey])
        ? readString(record[outerKey], innerKey)
        : null;
}

// A response is JSON iff its Content-Type mentions json (application/json,
// application/vnd.api+json, text/json, …). Anything else is dropped at the
// header stage so we never fetch bodies we intend to discard.
function isJsonMimeType(mimeType) {
    return typeof mimeType === "string" && /json/i.test(mimeType);
}

// ---- debugger attach / capture ----------------------------------------------

// Attach the debugger to a tab and begin capturing JSON responses. Idempotent:
// re-attaching to a tab that already has a session is a no-op that returns the
// existing session's buffer. Returns the tab's RingBuffer.
async function attachDebugger(tabId, options) {
    if (typeof tabId !== "number") {
        throw new Error("attachDebugger: tabId must be a number");
    }
    const existing = sessions.get(tabId);
    if (existing !== undefined) {
        return existing.buffer;
    }

    const maxBytes = isRecord(options) && typeof options.maxBytes === "number"
        ? options.maxBytes
        : DEFAULT_MAX_BYTES;
    const buffer = new CaptureBuffer(maxBytes);
    const inflight = new Map();
    const target = { tabId };

    const onEvent = (source, method, params) => {
        if (source.tabId !== tabId) {
            return;
        }
        void handleDebuggerEvent(target, method, params, inflight, buffer);
    };

    sessions.set(tabId, { buffer, inflight, onEvent });
    chrome.debugger.onEvent.addListener(onEvent);

    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
    await chrome.debugger.sendCommand(target, "Network.enable", {});
    await chrome.debugger.sendCommand(target, "Fetch.enable", {});
    return buffer;
}

// Route a single CDP event for a captured tab. Network.* build the entry;
// Fetch.requestPaused is continued immediately so browsing is never blocked.
async function handleDebuggerEvent(target, method, params, inflight, buffer) {
    if (method === "Fetch.requestPaused") {
        const requestId = readString(params, "requestId");
        if (requestId !== null) {
            await continueRequest(target, requestId);
        }
        return;
    }
    if (method === "Network.requestWillBeSent") {
        recordRequest(params, inflight);
        return;
    }
    if (method === "Network.responseReceived") {
        recordResponse(params, inflight);
        return;
    }
    if (method === "Network.loadingFinished") {
        await finalizeEntry(target, params, inflight, buffer);
    }
}

async function continueRequest(target, requestId) {
    try {
        await chrome.debugger.sendCommand(target, "Fetch.continueRequest", { requestId });
    }
    catch {
        // The request may already be gone (tab navigated); nothing to continue.
    }
}

function recordRequest(params, inflight) {
    const requestId = readString(params, "requestId");
    const url = readNestedString(params, "request", "url");
    const method = readNestedString(params, "request", "method");
    if (requestId === null || url === null) {
        return;
    }
    const requestHeaders = isRecord(params.request) && isRecord(params.request.headers)
        ? params.request.headers
        : {};
    inflight.set(requestId, { url, method: method ?? "", requestHeaders });
}

function recordResponse(params, inflight) {
    const requestId = readString(params, "requestId");
    if (requestId === null) {
        return;
    }
    const pending = inflight.get(requestId);
    if (pending === undefined) {
        return;
    }
    const mimeType = readNestedString(params, "response", "mimeType");
    if (!isJsonMimeType(mimeType)) {
        // Not JSON — drop before we ever fetch the body.
        inflight.delete(requestId);
        return;
    }
    const status = isRecord(params.response) && typeof params.response.status === "number"
        ? params.response.status
        : null;
    pending.statusCode = status;
    inflight.set(requestId, pending);
}

async function finalizeEntry(target, params, inflight, buffer) {
    const requestId = readString(params, "requestId");
    if (requestId === null) {
        return;
    }
    const pending = inflight.get(requestId);
    inflight.delete(requestId);
    if (pending === undefined) {
        return;
    }

    let body;
    try {
        body = await chrome.debugger.sendCommand(target, "Network.getResponseBody", { requestId });
    }
    catch {
        // Body already evicted from the CDP cache; skip this entry.
        return;
    }
    // Binary bodies arrive base64-encoded — the buffer is JSON-only, so drop.
    if (isRecord(body) && body.base64Encoded === true) {
        return;
    }
    const responseBody = readString(body, "body");
    if (responseBody === null) {
        return;
    }

    buffer.push({
        requestId,
        url: pending.url,
        method: pending.method,
        statusCode: pending.statusCode ?? null,
        requestHeaders: pending.requestHeaders,
        responseBody,
        capturedAt: new Date().toISOString(),
        sourcePlatform: sourcePlatformFor(pending.url),
    });
}

// ---- teardown ---------------------------------------------------------------

// Detach the debugger from a tab and return a snapshot of everything captured.
// Safe to call for an unknown tab (returns an empty array). Detach failures on
// an already-closed tab are non-fatal.
async function stopCapture(tabId) {
    const session = sessions.get(tabId);
    if (session === undefined) {
        return [];
    }
    sessions.delete(tabId);
    chrome.debugger.onEvent.removeListener(session.onEvent);
    try {
        await chrome.debugger.detach({ tabId });
    }
    catch {
        // Tab was closed before teardown; the debugger is already gone.
    }
    return session.buffer.snapshot();
}

export {
    sourcePlatformFor,
    attachDebugger,
    stopCapture,
};
