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
// Capture is a capability of the current run: sessions carry a run generation
// and are retired on every settlement (see retireCaptureSessions).

import { CaptureBuffer, DEFAULT_MAX_BYTES } from "./capture-buffer.js";
import {
  assertCaptureTabAllowed,
  redactResponseBody,
} from "./capture-policy.js";
import {
  isCredentialValue,
  redactCredentialText,
} from "./credential-policy.js";
import { normalizeCaptureSnapshot } from "./blueprint/input.js";
import { getAuthorizedOrigin } from "./session.js";

const DEBUGGER_PROTOCOL_VERSION = "1.3";
const MAX_PENDING = 1000;

// Per-tab capture state, keyed by tabId. Each entry owns its own ring buffer,
// inflight-request table, and the debugger event listener used to tear down.
const sessions = new Map();

// Why a tab's session ended, kept after the session object is gone so a later
// stop_capture reports the TRUTH ("the page navigated", "the run ended")
// instead of an empty, reasonless snapshot. Unknown is never zero: a capture
// that was thrown away says so. Cleared when a new session attaches to the tab
// and when a stop consumes it.
/** @type {Map<number, string>} */
const tombstones = new Map();

function tombstone(tabId, reason) {
  tombstones.set(tabId, reason);
}

// The snapshot a stop gets for a tab whose session already ended: no entries,
// and the recorded teardown reason so the loss is never reported as zero.
function tombstonedSnapshot(tabId) {
  const reason = tombstones.get(tabId);
  tombstones.delete(tabId);
  return captureSnapshot(
    [],
    null,
    new Map([[reason ?? "capture_never_started", 1]]),
  );
}

// Capture is a capability of the CURRENT run only. Every session is stamped
// with the generation it was attached under; retireCaptureSessions (called on
// every run settlement / session clear) bumps the generation and drains every
// debugger, and an event or stop for an obsolete generation is refused.
let captureGeneration = 0;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// A session is live only while it is current-generation AND its origin is
// still the run's authorized origin. Anything else is torn down on sight.
function isLiveSession(session) {
  return (
    session.generation === captureGeneration &&
    getAuthorizedOrigin() === session.expectedOrigin
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function readString(record, key) {
  return isRecord(record) && typeof record[key] === "string"
    ? record[key]
    : null;
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
  } catch {
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
    out[key] =
      isCredentialValue(key, value) || redactCredentialText(value) !== value
        ? REDACTED
        : value;
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
  } catch {
    return url;
  }
  const params = [...parsed.searchParams.entries()];
  if (params.length === 0) {
    return url;
  }
  let changed = false;
  const rebuilt = params.map(([key, value]) => {
    if (
      isCredentialValue(key, value) ||
      redactCredentialText(value) !== value
    ) {
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
// The tab URL is validated against the run's authorized origin (HTTPS, exact
// origin, live grant) BEFORE chrome.debugger.attach is called, so the debugger
// handle never exists for chrome://, file://, extension, or foreign pages.
async function attachDebugger(tabId, options) {
  if (typeof tabId !== "number") {
    throw new Error("attachDebugger: tabId must be a number");
  }
  const existing = sessions.get(tabId);
  if (existing !== undefined) {
    return existing.buffer;
  }
  const tab = await assertCaptureTabAllowed(tabId);
  const expectedOrigin = new URL(tab.url).origin;

  const maxBytes =
    isRecord(options) && typeof options.maxBytes === "number"
      ? options.maxBytes
      : DEFAULT_MAX_BYTES;
  const buffer = new CaptureBuffer(maxBytes);
  const inflight = new Map();
  // In-flight finalizer promises. loadingFinished fetches the body
  // asynchronously; stopCapture drains this set so a stop never races an
  // outstanding write (lost capture) or lets a late write land after snapshot.
  const finalizers = new Set();
  const excluded = new Map();
  const target = { tabId };
  const exclude = (reason, count = 1) =>
    excluded.set(reason, (excluded.get(reason) ?? 0) + count);

  const generation = captureGeneration;

  const onEvent = (source, method, params) => {
    if (source.tabId !== tabId) {
      return;
    }
    const session = sessions.get(tabId);
    if (session === undefined || session.onEvent !== onEvent) {
      return; // a torn-down session receives nothing
    }
    if (!isLiveSession(session)) {
      exclude("run_retired");
      void teardownSession(tabId, { detach: true, reason: "run_retired" });
      return;
    }
    // In-band navigation signal, MAIN FRAME ONLY: a top-level document request
    // for another origin means the tab itself is leaving the authorized
    // origin, so the handle must not follow it. Subframe traffic (an
    // about:blank widget, an analytics iframe, a same-site iframe) is ordinary
    // page behaviour: it is never recorded (recordRequest rejects any foreign
    // request URL) but it must NOT end the capture. tabs.onUpdated remains the
    // primary, authoritative navigation signal.
    const documentUrl = readString(params, "documentURL");
    if (documentUrl !== null && originOf(documentUrl) !== expectedOrigin) {
      if (isMainFrameNavigation(session, params)) {
        exclude("main_frame_navigated");
        void teardownSession(tabId, {
          detach: true,
          reason: "main_frame_navigated",
        });
        return;
      }
      // Foreign document, same tab: counted, never recorded, never fatal.
      exclude("foreign_document");
      return;
    }
    if (
      method === "Network.loadingFinished" &&
      finalizers.size >= MAX_PENDING
    ) {
      exclude("finalizer_full");
      return;
    }
    const done = handleDebuggerEvent(
      target,
      method,
      params,
      inflight,
      buffer,
      expectedOrigin,
      exclude,
    ).catch(() => exclude("malformed"));
    finalizers.add(done);
    void done.finally(() => finalizers.delete(done));
  };

  const session = {
    buffer,
    inflight,
    onEvent,
    finalizers,
    expectedOrigin,
    excluded,
    generation,
    // The tab's top-level frame, learned after attach. null when Chrome would
    // not tell us: in-band navigation teardown then defers entirely to
    // tabs.onUpdated rather than guessing from subframe traffic.
    /** @type {string | null} */
    rootFrameId: null,
  };
  sessions.set(tabId, session);
  tombstones.delete(tabId);
  chrome.debugger.onEvent.addListener(onEvent);

  try {
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
    // FAIL CLOSED BEFORE THE DOMAIN IS ENABLED. attach is awaited, so the tab
    // may have navigated (or the run settled, or the grant been withdrawn)
    // meanwhile. Network.enable is network-capture authority over whatever
    // document the tab now holds, so every check happens BEFORE it is sent:
    // an unauthorized destination never has the domain exercised on it.
    const live = await assertCaptureTabAllowed(tabId);
    if (originOf(live.url) !== expectedOrigin) {
      throw new Error("capture_tab_navigated");
    }
    if (!isLiveSession(session)) {
      throw new Error("capture_run_retired");
    }
    await chrome.debugger.sendCommand(target, "Network.enable", {});
    // And again after enabling: a navigation that landed during the enable
    // round trip tears the handle down before any event is honoured.
    const stillLive = await assertCaptureTabAllowed(tabId);
    if (originOf(stillLive.url) !== expectedOrigin) {
      throw new Error("capture_tab_navigated");
    }
    if (!isLiveSession(session)) {
      throw new Error("capture_run_retired");
    }
    session.rootFrameId = await readRootFrameId(target);
  } catch (err) {
    // A partial attach (coach denied the prompt, DevTools already open,
    // Network.enable rejected) must not leak a debugger handle, listener, or
    // a poisoned session that makes the next attach a false idempotent hit.
    // Roll every side effect back before surfacing the failure.
    chrome.debugger.onEvent.removeListener(onEvent);
    sessions.delete(tabId);
    try {
      await chrome.debugger.detach(target);
    } catch {
      // The attach never completed, so there may be nothing to detach.
      buffer.clear();
    }
    throw err;
  }
  return buffer;
}

// The tab's top-level frame id, or null when Chrome does not answer. Page is
// never ENABLED (no page-lifecycle events are subscribed); this is a single
// read of the frame tree so main-frame navigation can be told apart from
// subframe traffic.
async function readRootFrameId(target) {
  try {
    const tree = await chrome.debugger.sendCommand(
      target,
      "Page.getFrameTree",
      {},
    );
    const frameTree = isRecord(tree)
      ? /** @type {Record<string, unknown>} */ (tree).frameTree
      : null;
    const frame = isRecord(frameTree)
      ? /** @type {Record<string, unknown>} */ (frameTree).frame
      : null;
    return readString(frame, "id");
  } catch {
    return null;
  }
}

// Is this event a top-level document navigation of the captured tab? Only a
// main-frame document request counts; anything else (subframe documents,
// XHR/fetch/script/image issued by any document) is not a navigation of the
// tab. When the root frame is unknown, nothing in band is treated as a
// navigation: tabs.onUpdated is the authoritative signal.
function isMainFrameNavigation(session, params) {
  if (readString(params, "type") !== "Document") return false;
  const frameId = readString(params, "frameId");
  return (
    session.rootFrameId !== null &&
    frameId !== null &&
    frameId === session.rootFrameId
  );
}

// Route a single CDP event for a captured tab. Only Network.* events are handled
// — the Fetch domain is never enabled (v0.3 is passive-observe only).
async function handleDebuggerEvent(
  target,
  method,
  params,
  inflight,
  buffer,
  expectedOrigin,
  exclude,
) {
  if (method === "Network.requestWillBeSent") {
    recordRequest(params, inflight, expectedOrigin, exclude);
    return;
  }
  if (method === "Network.responseReceived") {
    recordResponse(params, inflight);
    return;
  }
  if (method === "Network.loadingFinished") {
    await finalizeEntry(target, params, inflight, buffer, exclude);
  }
}

function recordRequest(params, inflight, expectedOrigin, exclude) {
  const requestId = readString(params, "requestId");
  const url = readNestedString(params, "request", "url");
  const method = readNestedString(params, "request", "method");
  if (requestId === null || url === null) {
    if (requestId !== null) inflight.delete(requestId);
    exclude("malformed");
    return;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    inflight.delete(requestId);
    exclude("malformed");
    return;
  }
  // This check deliberately precedes reading headers: foreign request data
  // must never enter inflight state, the buffer, or body retrieval.
  if (parsed.origin !== expectedOrigin) {
    inflight.delete(requestId);
    exclude("origin_rejected");
    return;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    inflight.delete(requestId);
    exclude("userinfo_rejected");
    return;
  }
  const requestHeaders =
    isRecord(params.request) && isRecord(params.request.headers)
      ? params.request.headers
      : {};
  if (!inflight.has(requestId) && inflight.size >= MAX_PENDING) {
    inflight.delete(inflight.keys().next().value);
    exclude("inflight_evicted");
  }
  inflight.set(
    requestId,
    Object.freeze({
      url: redactUrl(url),
      method: method ?? "",
      requestHeaders: Object.freeze(redactHeaders(requestHeaders)),
    }),
  );
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
  const status =
    isRecord(params.response) && typeof params.response.status === "number"
      ? params.response.status
      : null;
  inflight.set(requestId, Object.freeze({ ...pending, statusCode: status }));
}

async function finalizeEntry(target, params, inflight, buffer, exclude) {
  const requestId = readString(params, "requestId");
  if (requestId === null) {
    return;
  }
  const pending = inflight.get(requestId);
  inflight.delete(requestId);
  if (pending === undefined) {
    return;
  }
  const encodedLength =
    isRecord(params) && typeof params.encodedDataLength === "number"
      ? params.encodedDataLength
      : 0;
  if (encodedLength > buffer.maxBytes) {
    exclude("buffer_full");
    return;
  }

  // No body is read for a session that stopped being live while this entry
  // was in flight (run settled, origin cleared, tab navigated).
  const session = sessions.get(target.tabId);
  if (session === undefined || !isLiveSession(session)) {
    exclude("run_retired");
    return;
  }
  let body;
  try {
    body = await chrome.debugger.sendCommand(
      target,
      "Network.getResponseBody",
      { requestId },
    );
  } catch {
    // Body already evicted from the CDP cache; skip this entry.
    exclude("malformed");
    return;
  }
  // Binary bodies arrive base64-encoded — the buffer is JSON-only, so drop.
  if (isRecord(body) && body.base64Encoded === true) {
    exclude("malformed");
    return;
  }
  const responseBody = readString(body, "body");
  if (responseBody === null) {
    exclude("malformed");
    return;
  }

  const outcome = buffer.push({
    requestId,
    url: pending.url,
    method: pending.method,
    statusCode: pending.statusCode ?? null,
    requestHeaders: pending.requestHeaders,
    // Auth/secret fields inside the body are redacted before storage; the
    // non-secret payload (client names, emails, workouts) is preserved.
    responseBody: redactResponseBody(responseBody),
    capturedAt: new Date().toISOString(),
    // Host provenance is derived from the original URL — the hostname is not
    // sensitive and is needed for the auto:<host> tag.
    sourcePlatform: sourcePlatformFor(pending.url),
  });
  if (outcome === null) {
    exclude("buffer_full");
  } else if (outcome.evicted > 0) {
    exclude("buffer_evicted", outcome.evicted);
  }
}

// ---- teardown ---------------------------------------------------------------

// Tear down a tab's capture session: stop listening, drain in-flight finalizers,
// snapshot, free the buffer, and (optionally) detach the debugger. Safe for an
// unknown tab (returns an empty array). `detach` is false only when Chrome has
// already detached (chrome.debugger.onDetach), where a detach call is redundant.
async function teardownSession(tabId, { detach, reason }) {
  const session = sessions.get(tabId);
  if (session === undefined) {
    return tombstonedSnapshot(tabId);
  }
  sessions.delete(tabId);
  if (typeof reason === "string") {
    tombstone(tabId, reason);
  }
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
    } catch {
      // Tab was closed before teardown; the debugger is already gone.
      session.buffer.clear();
    }
  }
  return captureSnapshot(snapshot, session.expectedOrigin, session.excluded);
}

function captureSnapshot(entries, expectedOrigin, excluded) {
  const reasons = [...excluded].map(([reason, count]) => ({ reason, count }));
  return {
    entries,
    expectedOrigin,
    incomplete: reasons.length > 0,
    degraded: reasons.length > 0,
    excluded: reasons,
  };
}

function normalizeCapturedSnapshot(snapshot) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.entries)) {
    return normalizeCaptureSnapshot(snapshot);
  }
  const options =
    snapshot.expectedOrigin === null
      ? undefined
      : { expectedOrigin: snapshot.expectedOrigin };
  const normalized = normalizeCaptureSnapshot(snapshot.entries, options);
  const counts = new Map(
    normalized.excluded.map(({ reason, count }) => [reason, count]),
  );
  for (const item of snapshot.excluded) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + item.count);
  }
  return {
    ...normalized,
    incomplete: snapshot.incomplete || normalized.excluded.length > 0,
    degraded: snapshot.degraded || normalized.excluded.length > 0,
    excluded: [...counts].map(([reason, count]) => ({ reason, count })),
  };
}

// Detach the debugger from a tab and return a snapshot of everything captured.
// A session that outlived its run (obsolete generation, or the run's origin is
// no longer authorized) is torn down but yields NO entries: its data belongs to
// a capability that has ended.
async function stopCapture(tabId) {
  const session = sessions.get(tabId);
  if (session !== undefined && !isLiveSession(session)) {
    await teardownSession(tabId, { detach: true, reason: "run_retired" });
    tombstones.delete(tabId);
    return captureSnapshot([], null, new Map([["run_retired", 1]]));
  }
  const snapshot = await teardownSession(tabId, {
    detach: true,
    reason: null,
  });
  tombstones.delete(tabId);
  return snapshot;
}

// End every capture session of the current run: bump the generation (so any
// event or stop that races this is refused), then detach and drain each
// debugger. Called on every run settlement and TGP session clear.
async function retireCaptureSessions() {
  captureGeneration += 1;
  await Promise.allSettled(
    [...sessions.keys()].map((tabId) =>
      teardownSession(tabId, { detach: true, reason: "run_retired" }),
    ),
  );
}

// Wire the MV3 lifecycle cleanup paths so a session never leaks its debugger
// handle or buffer when capture ends outside an explicit stop_capture:
//   - tabs.onRemoved       — the coach closed the captured tab.
//   - debugger.onDetach    — Chrome detached the debugger (e.g. DevTools opened).
//   - runtime.onSuspend    — the service worker is being torn down.
// Called once from the background service worker at startup.
function registerCaptureLifecycle() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void teardownSession(tabId, { detach: true, reason: "tab_closed" });
  });
  // The captured tab navigated: the handle must not follow it to another
  // origin (even one Chrome holds a grant for). Same-origin navigations keep
  // the session.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const session = sessions.get(tabId);
    const url = readString(changeInfo, "url");
    if (session === undefined || url === null) {
      return;
    }
    if (originOf(url) !== session.expectedOrigin) {
      session.excluded.set(
        "main_frame_navigated",
        (session.excluded.get("main_frame_navigated") ?? 0) + 1,
      );
      void teardownSession(tabId, {
        detach: true,
        reason: "main_frame_navigated",
      });
    }
  });
  // Chrome revoked a host grant: any session on that origin ends now, not at
  // its next event.
  chrome.permissions.onRemoved.addListener((permissions) => {
    const origins =
      isRecord(permissions) && Array.isArray(permissions.origins)
        ? permissions.origins
        : [];
    for (const [tabId, session] of [...sessions]) {
      if (origins.includes(`${session.expectedOrigin}/*`)) {
        void teardownSession(tabId, {
          detach: true,
          reason: "origin_revoked",
        });
      }
    }
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (isRecord(source) && typeof source.tabId === "number") {
      void teardownSession(source.tabId, {
        detach: false,
        reason: "debugger_detached",
      });
    }
  });
  chrome.runtime.onSuspend.addListener(() => {
    for (const tabId of [...sessions.keys()]) {
      void teardownSession(tabId, {
        detach: true,
        reason: "worker_suspended",
      });
    }
  });
}

export {
  sourcePlatformFor,
  redactHeaders,
  redactUrl,
  recordRequest,
  attachDebugger,
  stopCapture,
  retireCaptureSessions,
  normalizeCapturedSnapshot,
  registerCaptureLifecycle,
};
export {
  assertCaptureTabAllowed,
  redactResponseBody,
} from "./capture-policy.js";
