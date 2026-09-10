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
import { assertCaptureTabAllowed, redactResponseBody } from "./capture-policy.js";
import { isCredentialKey, redactCredentialText } from "./credential-policy.js";

const DEBUGGER_PROTOCOL_VERSION = "1.3";
const MAX_PENDING = 1000;

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

// Replace sensitive header values with the redaction marker. Header names are
// matched case-insensitively; every other header passes through untouched.
function redactHeaders(headers) {
    if (!isRecord(headers)) {
        return {};
    }
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        out[key] = isCredentialKey(key) || redactCredentialText(value) !== value ? REDACTED : value;
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
        if (isCredentialKey(key) || redactCredentialText(value) !== value) {
            changed = true;
            return `${encodeURIComponent(key)}=${REDACTED}`;
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
//
// The tab URL is validated against the capture allowlist (HTTPS + allowlisted
// host only) BEFORE chrome.debugger.attach is called, so the debugger handle
// never exists for chrome://, file://, extension, or non-allowlisted pages.
async function attachDebugger(tabId, options) {
    if (typeof tabId !== "number") {
        throw new Error("attachDebugger: tabId must be a number");
    }
    const existing = sessions.get(tabId);
    if (existing !== undefined) {
        return existing.buffer;
    }
    await assertCaptureTabAllowed(tabId);

    const maxBytes = isRecord(options) && typeof options.maxBytes === "number"
        ? options.maxBytes
        : DEFAULT_MAX_BYTES;
    const buffer = new CaptureBuffer(maxBytes);
    const inflight = new Map();
    // In-flight finalizer promises. loadingFinished fetches the body
    // asynchronously; stopCapture drains this set so a stop never races an
    // outstanding write (lost capture) or lets a late write land after snapshot.
    const finalizers = new Set();
    const target = { tabId };

    const onEvent = (source, method, params) => {
        if (source.tabId !== tabId) {
            return;
        }
        if (finalizers.size >= MAX_PENDING) return;
        const done = handleDebuggerEvent(target, method, params, inflight, buffer).catch(
            () => undefined,
        );
        finalizers.add(done);
        void done.finally(() => finalizers.delete(done));
    };

    sessions.set(tabId, { buffer, inflight, onEvent, finalizers });
    chrome.debugger.onEvent.addListener(onEvent);

    try {
        await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
        await chrome.debugger.sendCommand(target, "Network.enable", {});
    }
    catch (err) {
        // A partial attach (coach denied the prompt, DevTools already open,
        // Network.enable rejected) must not leak a debugger handle, listener, or
        // a poisoned session that makes the next attach a false idempotent hit.
        // Roll every side effect back before surfacing the failure.
        chrome.debugger.onEvent.removeListener(onEvent);
        sessions.delete(tabId);
        try {
            await chrome.debugger.detach(target);
        }
        catch {
            // The attach never completed, so there may be nothing to detach.
        }
        throw err;
    }
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
    if (!inflight.has(requestId) && inflight.size >= MAX_PENDING) {
        inflight.delete(inflight.keys().next().value);
    }
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
    const encodedLength = isRecord(params) && typeof params.encodedDataLength === "number"
        ? params.encodedDataLength : 0;
    if (encodedLength > buffer.maxBytes) return;

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
    if (responseBody === null || responseBody.length > buffer.maxBytes) {
        return;
    }

    buffer.push({
        requestId,
        url: redactUrl(pending.url),
        method: pending.method,
        statusCode: pending.statusCode ?? null,
        requestHeaders: redactHeaders(pending.requestHeaders),
        // Auth/secret fields inside the body are redacted before storage; the
        // non-secret payload (client names, emails, workouts) is preserved.
        responseBody: redactResponseBody(responseBody),
        capturedAt: new Date().toISOString(),
        // Host provenance is derived from the original URL — the hostname is not
        // sensitive and is needed for the auto:<host> tag.
        sourcePlatform: sourcePlatformFor(pending.url),
    });
}

// ---- teardown ---------------------------------------------------------------

// Tear down a tab's capture session: stop listening, drain in-flight finalizers,
// snapshot, free the buffer, and (optionally) detach the debugger. Safe for an
// unknown tab (returns an empty array). `detach` is false only when Chrome has
// already detached (chrome.debugger.onDetach), where a detach call is redundant.
async function teardownSession(tabId, { detach }) {
    const session = sessions.get(tabId);
    if (session === undefined) {
        return [];
    }
    sessions.delete(tabId);
    chrome.debugger.onEvent.removeListener(session.onEvent);
    // Wait for any finalizer already in flight so its body write lands in the
    // buffer before we snapshot, and no orphan write occurs after we resolve.
    await Promise.allSettled([...session.finalizers]);
    const snapshot = session.buffer.snapshot();
    // Free the captured bytes eagerly — cleanup paths (tab close, SW suspend)
    // must not leave a buffer pinned in memory.
    session.buffer.clear();
    if (detach) {
        try {
            await chrome.debugger.detach({ tabId });
        }
        catch {
            // Tab was closed before teardown; the debugger is already gone.
        }
    }
    return snapshot;
}

// Detach the debugger from a tab and return a snapshot of everything captured.
async function stopCapture(tabId) {
    return teardownSession(tabId, { detach: true });
}

// Wire the MV3 lifecycle cleanup paths so a session never leaks its debugger
// handle or buffer when capture ends outside an explicit stop_capture:
//   - tabs.onRemoved       — the coach closed the captured tab.
//   - debugger.onDetach    — Chrome detached the debugger (e.g. DevTools opened).
//   - runtime.onSuspend    — the service worker is being torn down.
// Called once from the background service worker at startup.
function registerCaptureLifecycle() {
    chrome.tabs.onRemoved.addListener((tabId) => {
        void teardownSession(tabId, { detach: true });
    });
    chrome.debugger.onDetach.addListener((source) => {
        if (isRecord(source) && typeof source.tabId === "number") {
            void teardownSession(source.tabId, { detach: false });
        }
    });
    chrome.runtime.onSuspend.addListener(() => {
        for (const tabId of [...sessions.keys()]) {
            void teardownSession(tabId, { detach: true });
        }
    });
}

export {
    sourcePlatformFor,
    redactHeaders,
    redactUrl,
    attachDebugger,
    stopCapture,
    registerCaptureLifecycle,
};
export { assertCaptureTabAllowed, redactResponseBody } from "./capture-policy.js";
