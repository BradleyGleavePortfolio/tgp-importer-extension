// Layer 1 passive capture for the TGP Importer (see docs/AUTO_DISCOVERY.md §6).
//
// Attaches chrome.debugger to a tab, enables ONLY the Network domain, and
// records JSON responses into a byte-bounded capture buffer tagged with a
// `auto:<hostname>` source-platform provenance marker. v0.3 is passive capture
// only: the Fetch domain (which pauses every request) is deliberately NOT
// enabled — capture happens purely via Network.* observation, so the coach's
// own browsing is never intercepted or stalled.
//
// Privacy: sensitive request headers (Authorization / Cookie / Set-Cookie) and
// token-bearing URL query params are redacted to "<redacted>" before an entry
// is ever stored, so raw credentials never enter the buffer or cross the
// runtime-message boundary.
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

// ---- redaction --------------------------------------------------------------

const REDACTED = "<redacted>";
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie"]);
const SENSITIVE_QUERY_KEY = /^(token|access_token|id_token|api[-_]?key|auth|session)$/i;

// Replace sensitive header values with the redaction marker. Header names are
// matched case-insensitively; every other header passes through untouched.
function redactHeaders(headers) {
    if (!isRecord(headers)) {
        return {};
    }
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value;
    }
    return out;
}

// Redact token-bearing query params (token, access_token, id_token, api_key,
// auth, session) to the literal marker, leaving all other params intact. The
// literal marker is preserved rather than percent-encoded so downstream tooling
// can recognise it. Malformed URLs pass through unchanged.
function redactUrl(url) {
    if (typeof url !== "string") {
        return url;
    }
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return url;
    }
    const params = [...parsed.searchParams.entries()];
    if (params.length === 0) {
        return url;
    }
    let changed = false;
    const rebuilt = params.map(([key, value]) => {
        if (SENSITIVE_QUERY_KEY.test(key)) {
            changed = true;
            return `${key}=${REDACTED}`;
        }
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    });
    if (!changed) {
        return url;
    }
    return `${parsed.origin}${parsed.pathname}?${rebuilt.join("&")}${parsed.hash}`;
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
    return buffer;
}

// Route a single CDP event for a captured tab. Only Network.* events are handled
// — the Fetch domain is never enabled (v0.3 is passive-observe only).
async function handleDebuggerEvent(target, method, params, inflight, buffer) {
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
        url: redactUrl(pending.url),
        method: pending.method,
        statusCode: pending.statusCode ?? null,
        requestHeaders: redactHeaders(pending.requestHeaders),
        responseBody,
        capturedAt: new Date().toISOString(),
        // Host provenance is derived from the original URL — the hostname is not
        // sensitive and is needed for the auto:<host> tag.
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
    redactHeaders,
    redactUrl,
    attachDebugger,
    stopCapture,
};
