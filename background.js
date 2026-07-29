// TGP Importer — MV3 background service worker.
//
// Responsibilities (see docs/DESIGN.md §2, §4, §7, §10):
//   - On install: seed the storage schema + empty progress snapshot.
//   - On `session_established`: hand the token pair to shared/session.js, the
//     single session-ownership boundary. The pairing view (popup/pair.js) is
//     the ONLY producer of this message.
//   - On `start_ingest`: verify token, pick the extractor via detectPlatform,
//     wire sendEntities (bearer POST) + broadcastStatus (runtime message).
//   - On `request_status` / `request_session_state`: return the snapshot / a
//     non-secret hasSession boolean.
//   - Token lifecycle lives entirely in shared/session.js (memory-only access
//     token, chrome.storage.session refresh token). On 401 mid-crawl we refresh
//     once; if that also fails we clear local token state + broadcast
//     `auth_required` (there is no server logout endpoint yet — no revocation
//     is claimed).
//   - On completion: chrome.notifications + POST /api/scout/ingest/complete.
//   - On SW wake: the snapshot rehydrates from disk; credentials live in
//     memory / storage.session only, so a fresh pair may be required.
//     Do NOT resume an in-flight run (runs are idempotent per sourceId; the
//     backend de-dupes, so a re-emitted completed batch is harmless).
//
// R75: zero banned type-assertions — every narrowing is a real guard.
import { TGP_API_ORIGIN, makeScoutIngestBody } from "./shared/protocol.js";
import {
    establishSession,
    hasActiveSession,
    getAccessToken,
    refreshAccessToken,
    clearTokens,
} from "./shared/session.js";
import { detectPlatform } from "./extractors/detect.js";
import { TrueCoachExtractor } from "./extractors/truecoach.js";
import { runReplay, AuthLostError, isAuthLost } from "./shared/replay/engine.js";
import { resolveBlueprint, isUnknownPlatform } from "./shared/replay/resolve.js";
import { fetchWithTimeout, isTimeout, parseRetryAfterMs, readHeader } from "./shared/net.js";
import { createProgressReporter } from "./shared/progress.js";
import {
    attachDebugger,
    stopCapture,
    registerCaptureLifecycle,
    assertCaptureTabAllowed,
} from "./shared/capture.js";

// On-disk storage schema keys. Only the non-secret snapshot + schema version
// live in disk-persisted storage. The refresh secret is owned exclusively by
// shared/session.js (chrome.storage.session); no credential ever touches
// on-disk storage, even with the `debugger` permission held (§4).
const STORAGE_KEYS = {
    snapshot: "tgp_status_snapshot",
    schemaVersion: "tgp_schema_version",
    // Non-secret, stable per-install identifier the backend's progress DTO
    // requires. Random, never derived from anything about the coach or machine,
    // so it is not a fingerprint — it only lets the backend attribute concurrent
    // progress streams to distinct installs.
    deviceId: "tgp_device_id",
};

// The one live snapshot the popup renders.
let currentSnapshot = emptySnapshot();

function emptySnapshot() {
    return { kind: "status_snapshot", intent: null, progress: [], lastError: null };
}

function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isStartIngest(m) {
    return isRecord(m) && m.kind === "start_ingest";
}
function isStartImport(m) {
    return isRecord(m) && m.kind === "start_import";
}
function isRequestStatus(m) {
    return isRecord(m) && m.kind === "request_status";
}
function isRequestSessionState(m) {
    return isRecord(m) && m.kind === "request_session_state";
}
function isStartCapture(m) {
    return isRecord(m) && m.kind === "start_capture";
}
function isStopCapture(m) {
    return isRecord(m) && m.kind === "stop_capture";
}
function isSessionEstablished(m) {
    return isRecord(m) && m.kind === "session_established";
}
function readTabId(m) {
    return isRecord(m) && typeof m.tabId === "number" ? m.tabId : null;
}
function readString(record, key) {
    return isRecord(record) && typeof record[key] === "string" ? record[key] : null;
}

// ---- ingest transport -------------------------------------------------------

// A TGP-side auth loss (refresh exhausted mid-crawl), distinct from the source
// AuthLostError: routes to PAIRING. Its own type keeps the single friendly
// "session expired" terminal state from being overwritten by the run's catch.
function tgpAuthLost() {
    const err = new Error("auth_required");
    err.name = "TgpAuthLostError";
    return err;
}
function isTgpAuthLost(err) {
    return err instanceof Error && err.name === "TgpAuthLostError";
}

// POST a batch to /api/scout/ingest with the bearer token (finite timeout).
// On 401, refresh once and retry. If the retry also 401s, invoke onAuthLost and stop.
function makeSender(intent, onAuthLost) {
    return async function sendEntities(entityType, entities) {
        // Entities pass through VERBATIM — each is the camelCase makeEntity()
        // envelope { sourceId, sourcePlatform, capturedAt, payload } that the
        // backend ScoutEntityDto validates 1:1 (R80-CLARIFY-1). Re-mapping or
        // renaming here would 400 every batch.
        const body = JSON.stringify(makeScoutIngestBody(intent.intentId, entityType, entities));
        const attempt = async (token) => fetchWithTimeout(fetch, `${TGP_API_ORIGIN}/api/scout/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body,
        });
        let token = await getAccessToken();
        let res = await attempt(token);
        if (res.status === 401) {
            const refreshed = await refreshAccessToken();
            if (refreshed === null) {
                await clearTokens();
                onAuthLost();
                throw tgpAuthLost();
            }
            token = refreshed;
            res = await attempt(token);
            if (res.status === 401) {
                await clearTokens();
                onAuthLost();
                throw tgpAuthLost();
            }
        }
        if (!res.ok) {
            throw new Error(`ingest ${entityType} -> ${res.status}`);
        }
    };
}

// Map an engine result status onto the backend's ScoutCompleteDto terminal_status
// enum. The vocabularies are NOT the same: the engine's "complete" has no member
// on the backend (it is "success"), and "empty" is an extension-side distinction
// the backend has no word for — a clean-but-zero walk is reported as "partial"
// plus an error_summary, because calling it success would assert the coach has no
// data when the far likelier cause is blueprint drift.
const TERMINAL_STATUS = {
    complete: "success",
    partial: "partial",
    empty: "partial",
    failed: "failed",
};

// POST the terminal settlement for a run. `terminal_status` is REQUIRED by
// ScoutCompleteDto, and the backend runs a global ValidationPipe with
// forbidNonWhitelisted, so an unknown field is a 400 — `platform` used to be sent
// and is not on the DTO, which meant every complete was rejected and every run
// stayed "running" on the backend forever. Only DTO fields go on the wire.
// `outcome.terminalStatus` is required rather than defaulted: a success-shaped
// default is exactly how a run that did something else ends up reported as one.
async function completeIngest(intent, outcome) {
    const token = await getAccessToken();
    const body = { intent_id: intent.intentId, terminal_status: outcome.terminalStatus };
    if (outcome.finalCounts !== undefined && outcome.finalCounts !== null) {
        body.final_counts = outcome.finalCounts;
    }
    // Counts and status categories only — never a response body, URL, or PII.
    if (typeof outcome.errorSummary === "string" && outcome.errorSummary.length > 0) {
        body.error_summary = outcome.errorSummary.slice(0, 2000);
    }
    let res;
    try {
        res = await fetchWithTimeout(fetch, `${TGP_API_ORIGIN}/api/scout/ingest/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
    }
    catch (err) {
        // Bounded: a hung complete must not pin the MV3 worker. Fail closed so
        // the caller can surface ingest_failed rather than hang forever.
        if (isTimeout(err)) {
            throw new Error("complete_timeout");
        }
        throw err;
    }
    // Never claim success without a backend ack: a non-2xx complete means the run
    // did NOT finalise, so surface it instead of a dishonest ingest_succeeded.
    if (!res.ok) {
        throw new Error(`complete ${res.status}`);
    }
}

// Best-effort terminal settlement for a run that THREW — a source 401/403, an
// ingest transport error, anything that escaped the orchestration. An intent that
// was started and never settled sits "running" on the backend forever, which is
// the same data-integrity defect as a rejected complete, just reached by a
// different door. No counts are available on this path and `final_counts` is
// optional, so it is omitted rather than guessed. Never throws: the failure the
// coach actually needs to see must not be masked by a settlement fault.
function settleFailed(intent, errorSummary) {
    return completeIngest(intent, { terminalStatus: TERMINAL_STATUS.failed, errorSummary })
        .catch(() => undefined);
}

// ---- progress transport -----------------------------------------------------

// Read (or mint once) the non-secret per-install device id the progress DTO
// requires. Random UUID only — no coach, machine, or browser attribute is used.
// Returns "" if storage is unavailable: progress is advisory, so a storage
// failure must silence reporting, never fail the coach's import.
async function getDeviceId() {
    try {
        const stored = await chrome.storage.local.get(STORAGE_KEYS.deviceId);
        const existing = readString(stored, STORAGE_KEYS.deviceId);
        if (existing !== null && existing.length > 0) {
            return existing;
        }
        const minted = `ext-${crypto.randomUUID()}`;
        await chrome.storage.local.set({ [STORAGE_KEYS.deviceId]: minted });
        return minted;
    }
    catch {
        return "";
    }
}

// Bearer POST to /api/scout/progress. Rejects on a non-2xx so the reporter can
// count it as a failed report; the reporter swallows it (progress is advisory and
// must never fail an import).
function postProgress(body) {
    return getAccessToken().then(async (token) => {
        const res = await fetchWithTimeout(fetch, `${TGP_API_ORIGIN}/api/scout/progress`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`progress ${res.status}`);
        }
    });
}

// ---- install / wake ---------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
    void chrome.storage.local.set({
        [STORAGE_KEYS.snapshot]: emptySnapshot(),
        [STORAGE_KEYS.schemaVersion]: 1,
    });
});

// On SW wake there is no in-memory access token; rehydrate the snapshot for the
// popup. The access token is minted lazily by getAccessToken() on first use.
chrome.runtime.onStartup.addListener(() => {
    void rehydrateSnapshot();
});

async function rehydrateSnapshot() {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.snapshot);
    const snap = stored[STORAGE_KEYS.snapshot];
    currentSnapshot = isRecord(snap) ? snap : emptySnapshot();
}

// ---- broadcast --------------------------------------------------------------

function broadcastStatus(snapshot) {
    currentSnapshot = { ...emptySnapshot(), ...snapshot, kind: "status_snapshot" };
    void chrome.storage.local.set({ [STORAGE_KEYS.snapshot]: currentSnapshot });
    // Best-effort: the popup may be closed, in which case sendMessage rejects.
    chrome.runtime.sendMessage(currentSnapshot).catch(() => undefined);
}

function broadcastAuthRequired(message) {
    broadcastStatus({ ...emptySnapshot(), lastError: message ?? "auth_required" });
    chrome.runtime.sendMessage({ kind: "auth_required" }).catch(() => undefined);
}

// The OS notification is the most visible surface and often the ONLY one a
// coach sees, so it must not say "complete" for an outcome the popup is about to
// flag. An empty (drift-suspected) or partial walk gets its own wording.
function notifyOutcome(platform, engineStatus) {
    const message = engineStatus === "empty"
        ? `Import from ${platform} found no records — check the popup.`
        : (engineStatus === "partial"
            ? `Import from ${platform} finished incomplete — check the popup.`
            : `Import from ${platform} complete.`);
    chrome.notifications.create({
        type: "basic",
        iconUrl: "popup/icon-128.png",
        title: "TGP Importer",
        message,
    });
}

// ---- ingest run -------------------------------------------------------------

function extractorFor(platform, deps) {
    if (platform === "truecoach") {
        return new TrueCoachExtractor(deps);
    }
    // v0.3: other platforms currently return null from detectPlatform, so this
    // branch is unreachable until the next platform's extractor lands.
    return null;
}

async function handleStartIngest(message) {
    const url = typeof message.url === "string" ? message.url : "";
    const platform = detectPlatform(url);
    if (platform === null) {
        broadcastStatus({ ...emptySnapshot(), lastError: `unsupported site: ${url}` });
        return;
    }
    // Verify we have (or can mint) a TGP access token before starting.
    let accessToken;
    try {
        accessToken = await getAccessToken();
    }
    catch {
        broadcastAuthRequired("login required to import");
        return;
    }
    if (typeof accessToken !== "string" || accessToken.length === 0) {
        broadcastAuthRequired("login required to import");
        return;
    }

    const controller = new AbortController();
    const intent = { intentId: `ext-${Date.now()}`, platform, status: "ingest_started" };
    broadcastStatus({ ...emptySnapshot(), intent, progress: [] });

    const sendEntities = makeSender(intent, () => {
        controller.abort();
        broadcastAuthRequired("session expired — please sign in again");
    });
    const wrappedBroadcast = (snap) => broadcastStatus({ ...snap, intent });

    // The source-platform bearer token (e.g. TrueCoach) is captured in-tab and
    // passed on the start message; the extractor reuses the coach's session.
    const sourceToken = typeof message.sourceToken === "string" ? message.sourceToken : "";

    const extractor = extractorFor(platform, {
        sendEntities,
        broadcastStatus: wrappedBroadcast,
        now: () => new Date(),
    });
    if (extractor === null) {
        broadcastStatus({ ...emptySnapshot(), lastError: `no extractor for ${platform}` });
        return;
    }

    let settlementSent = false;
    try {
        await extractor.run({ token: sourceToken, signal: controller.signal });
        settlementSent = true;
        await completeIngest(intent, { terminalStatus: TERMINAL_STATUS.complete });
        broadcastStatus({ ...currentSnapshot, intent: { ...intent, status: "ingest_succeeded" } });
        notifyOutcome(platform, "complete");
    }
    catch (err) {
        // TGP-side auth loss already broadcast the friendly re-pair state; keep it.
        if (isTgpAuthLost(err)) {
            return;
        }
        const detail = err instanceof Error ? err.message : "import failed";
        // Same unsettled-intent defect as the replay path: an extractor that threw
        // leaves the run "running" on the backend unless it is settled here.
        if (!settlementSent) {
            await settleFailed(intent, detail);
        }
        broadcastStatus({
            ...currentSnapshot,
            intent: { ...intent, status: "ingest_failed" },
            lastError: detail,
        });
    }
}

// ---- autonomous replay run (start_import) -----------------------------------
// Single-flight: a boolean set SYNCHRONOUSLY in the router before the async
// handler runs (so a pre-await race cannot pass) and SHARED across BOTH ingest
// entrypoints (start_import + legacy start_ingest). Cleared when the run settles.
let importInFlight = false;

// Confine the crawl to the origin the coach is looking at: the observed tab
// origin (https only) is the injected SSRF allowlist the blueprint's apiBase must
// match. Never a hardcoded competitor map — site-agnostic by construction.
function tabOriginAllowlist(url) {
    let u;
    try {
        u = new URL(url);
    }
    catch {
        return null;
    }
    return u.protocol === "https:" ? [u.origin] : null;
}

// Build the injected fetchJson the engine calls per page: carries the SOURCE bearer
// + in-tab cookies. A source 401/403 maps to AuthLostError so the run fails closed
// WITHOUT clearTokens() — source auth loss never clears the TGP tokens.
function makeSourceFetch(sourceToken) {
    return async function fetchJson(url, { method, headers: injected, signal, timeoutMs }) {
        // Blueprint-declared headers are adapter DATA (auto-inferred from untrusted
        // capture in PR-C2). Copy them in but DROP any Authorization the adapter
        // tries to set (case-insensitively — fetch treats header names that way),
        // then apply the coach's SOURCE bearer LAST. So adapter data can never spoof
        // OR smuggle the source bearer, even when no live token is present.
        const headers = {};
        for (const [k, v] of Object.entries(injected ?? {})) {
            if (k.toLowerCase() === "authorization") {
                continue;
            }
            headers[k] = v;
        }
        if (sourceToken.length > 0) {
            headers.Authorization = `Bearer ${sourceToken}`;
        }
        const res = await fetchWithTimeout(fetch, url, { method, headers, credentials: "include", signal }, timeoutMs);
        if (res.status === 401 || res.status === 403) {
            throw new AuthLostError();
        }
        if (!res.ok) {
            const err = new Error(`source ${res.status}`);
            err.name = "HttpError";
            err.status = res.status;
            // Honour the source's own pacing hint (bounded at parse time). 503 is
            // the other status that commonly carries it. Absent/unparseable leaves
            // it undefined and the engine falls back to exponential backoff.
            const hinted = parseRetryAfterMs(readHeader(res, "Retry-After"));
            if (hinted !== null) {
                err.retryAfterMs = hinted;
            }
            throw err;
        }
        try {
            return await res.json();
        }
        catch {
            const err = new Error("source_bad_json");
            err.name = "MalformedResponseError";
            throw err;
        }
    };
}

// Obtain the SOURCE bearer from the coach's own tab WITHOUT exposing it to
// popup/storage/logs/payload: re-read the tab's LIVE origin and require it in the
// allowlist (fail closed on a navigated tab), accept only { ok, token }. Memory only.
async function collectSourceToken(tabId, allowedOrigins) {
    if (typeof tabId !== "number") {
        return "";
    }
    let tab;
    try {
        tab = await chrome.tabs.get(tabId);
    }
    catch {
        return "";
    }
    const origin = tabOriginAllowlist(readString(tab, "url"))?.[0] ?? null;
    if (origin === null || !allowedOrigins.includes(origin)) {
        return ""; // the tab is not (or no longer) the confirmed source origin
    }
    let reply;
    try {
        reply = await chrome.tabs.sendMessage(tabId, { kind: "collect_source_token" });
    }
    catch {
        return ""; // no content script / port closed — proceed token-less (fails closed downstream)
    }
    return isRecord(reply) && reply.ok === true && typeof reply.token === "string" ? reply.token : "";
}

async function handleStartImport(message) {
    const url = typeof message.url === "string" ? message.url : "";
    const platform = detectPlatform(url);
    if (platform === null) {
        broadcastStatus({ ...emptySnapshot(), lastError: `unsupported site: ${url}` });
        return;
    }
    const allowedOrigins = tabOriginAllowlist(url);
    if (allowedOrigins === null) {
        broadcastStatus({ ...emptySnapshot(), lastError: `unsafe import origin: ${url}` });
        return;
    }
    let blueprint;
    try {
        blueprint = resolveBlueprint(platform);
    }
    catch (err) {
        const detail = isUnknownPlatform(err) ? `no blueprint for ${platform}` : "blueprint resolve failed";
        broadcastStatus({ ...emptySnapshot(), lastError: detail });
        return;
    }
    // A TGP access token is required for ingest before we start crawling.
    let accessToken;
    try {
        accessToken = await getAccessToken();
    }
    catch {
        broadcastAuthRequired("login required to import");
        return;
    }
    if (typeof accessToken !== "string" || accessToken.length === 0) {
        broadcastAuthRequired("login required to import");
        return;
    }

    const controller = new AbortController();
    const intent = { intentId: `imp-${Date.now()}`, platform, status: "ingest_started" };
    broadcastStatus({ ...emptySnapshot(), intent, progress: [] });

    const sendEntities = makeSender(intent, () => {
        // TGP-side auth loss: makeSender already cleared the tokens; route to pairing.
        controller.abort();
        broadcastAuthRequired("session expired — please sign in again");
    });
    // Real source bearer from the coach's own tab; absent -> "" -> fails closed.
    const sourceToken = await collectSourceToken(message.tabId, allowedOrigins);
    const reporter = createProgressReporter({
        postProgress,
        intentId: intent.intentId,
        deviceId: await getDeviceId(),
    });

    // Whether a settlement has already been POSTed for this intent. A throw AFTER
    // that point is a rejected complete, not an unsettled run, and re-settling it
    // as "failed" would put a failure on the coach's record for a run that did not
    // fail.
    let settlementSent = false;
    try {
        const result = await runReplay({
            blueprint,
            fetchJson: makeSourceFetch(sourceToken),
            emit: (entityType, batch) => sendEntities(entityType, batch),
            onProgress: (rows) => {
                broadcastStatus({ ...currentSnapshot, intent, progress: rows });
                reporter.report(rows);
            },
            signal: controller.signal,
            allowedOrigins,
        });
        const terminalStatus = TERMINAL_STATUS[result.status];
        if (terminalStatus === undefined) {
            // cancelled — the coach stopped it, so there is nothing to settle.
            broadcastStatus({ ...currentSnapshot, intent: { ...intent, status: "ingest_failed" }, lastError: failDetail(result) });
            return;
        }
        const detail = terminalDetail(result);
        const settlement = {
            terminalStatus,
            // A per-entity tally, keyed by the same entity types the progress
            // stream reports. The previous { pages, entities } shape read as a
            // count of two entity types the coach does not have: "pages" is not an
            // entity at all, and "entities" is a total masquerading as one.
            finalCounts: result.counts,
            errorSummary: detail ?? undefined,
        };
        settlementSent = true;
        if (result.status === "failed") {
            // Settle best-effort so the intent does not sit "running" forever,
            // but never let a failed settlement mask the source failure the coach
            // actually needs to see.
            await completeIngest(intent, settlement).catch(() => undefined);
            broadcastStatus({ ...currentSnapshot, intent: { ...intent, status: "ingest_failed" }, lastError: detail });
            return;
        }
        // A non-failed outcome still requires a backend ack before we report it:
        // a throw here surfaces as ingest_failed rather than a dishonest success.
        await completeIngest(intent, settlement);
        await reporter.flush(null, detail ?? undefined);
        broadcastStatus({
            ...currentSnapshot,
            intent: { ...intent, status: intentStatusFor(result.status) },
            lastError: detail,
        });
        notifyOutcome(platform, result.status);
    }
    catch (err) {
        // TGP auth loss already broadcast the friendly "session expired" state; keep
        // it. The intent stays unsettled because the tokens it would be settled with
        // are exactly the ones that were just cleared — an unauthenticated complete
        // would only 401. Settling it needs a re-pair, not another POST here.
        if (isTgpAuthLost(err)) {
            return;
        }
        // Source auth loss is fail-closed but NOT a TGP logout: prompt a source re-login.
        const detail = isAuthLost(err)
            ? "source sign-in required — open your source platform and try again"
            : (err instanceof Error ? err.message : "import failed");
        // The TGP session is still good on this path, so the started intent CAN be
        // settled — and must be, before the coach is told the run is over.
        if (!settlementSent) {
            await settleFailed(intent, detail);
        }
        broadcastStatus({ ...currentSnapshot, intent: { ...intent, status: "ingest_failed" }, lastError: detail });
    }
}

// Popup-facing intent status per engine outcome. "empty" gets its OWN state:
// showing it as succeeded would tell the coach their source has no data, and
// showing it as failed would be wrong too — nothing errored. It needs checking.
function intentStatusFor(engineStatus) {
    if (engineStatus === "complete") {
        return "ingest_succeeded";
    }
    if (engineStatus === "empty") {
        return "ingest_empty";
    }
    if (engineStatus === "partial") {
        return "ingest_partial";
    }
    return "ingest_failed";
}

// One human/diagnostic line per outcome, or null when the run was wholly clean.
// Counts and status categories only — never a response body or PII.
function terminalDetail(result) {
    if (result.status === "complete") {
        return null;
    }
    if (result.status === "empty") {
        return "no records found — the source returned 0 records with no errors, "
            + "which usually means the import adapter is out of date. Nothing was changed.";
    }
    if (result.status === "partial") {
        return partialDetail(result);
    }
    return failDetail(result);
}

// Terminal detail carrying only counts + failure category/status — never a
// response body or PII (a 5xx skip stays diagnosable via lastSkipStatus).
function partialDetail(result) {
    const parts = [];
    if (result.degraded === true) parts.push("some pages were skipped");
    if (result.truncated === true) parts.push("reached the import safety limit");
    const why = parts.length > 0 ? parts.join("; ") : "incomplete";
    return `partial import (${why}) — ${result.entities} record(s) imported`;
}
function failDetail(result) {
    if (result.status === "cancelled") return "import cancelled";
    const s = result.lastSkipStatus;
    return typeof s === "number" || typeof s === "string" ? `import failed — source responded ${s}` : "import failed";
}

// ---- capture control --------------------------------------------------------

// Wire the MV3 cleanup paths (tab close, debugger detach, SW suspend) once at
// service-worker startup so a capture session never leaks its debugger handle or
// buffer when it ends outside an explicit stop_capture.
registerCaptureLifecycle();

// Begin Layer 1 passive capture on a tab. The ring buffer lives inside the
// capture module; the popup only sees start/stop control here (C3 renders it).
// The origin allowlist is asserted here BEFORE any debugger API call (and
// again inside attachDebugger, as defence in depth) so the `debugger`
// permission is never exercised against a non-allowlisted page.
async function handleStartCapture(tabId) {
    await assertCaptureTabAllowed(tabId);
    await attachDebugger(tabId);
    return { ok: true, tabId };
}

// Stop capture and hand the caller the JSON entries collected for that tab.
async function handleStopCapture(tabId) {
    const entries = await stopCapture(tabId);
    return { ok: true, tabId, entries };
}

// ---- message router ---------------------------------------------------------

// A token-bearing message is only trusted from one of THIS extension's own
// pages (the popup / pairing view): same extension id, an extension-origin URL,
// and no originating tab. A content script shares our id but carries a web-page
// URL + a `tab`, so this rejects a compromised content script trying to inject
// a forged session (§13.4) — ID-only trust is not enough for secrets.
function isTrustedExtensionPage(sender) {
    return (
        isRecord(sender) &&
        sender.id === chrome.runtime.id &&
        sender.tab === undefined &&
        typeof sender.url === "string" &&
        sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)
    );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only trust messages originating from this extension's own pages/scripts.
    // onMessageExternal is never registered, so cross-extension senders have no
    // entry point; this guard also rejects any spoofed/undefined sender.
    if (!isRecord(sender) || sender.id !== chrome.runtime.id) {
        return false;
    }
    if (isRequestStatus(message)) {
        void rehydrateSnapshot().then(() => sendResponse(currentSnapshot));
        return true; // async response
    }
    if (isRequestSessionState(message)) {
        // Non-secret routing/observability signal for the popup: a boolean only,
        // never any token material.
        hasActiveSession().then(
            (has) => sendResponse({ ok: true, hasSession: has }),
            () => sendResponse({ ok: true, hasSession: false }),
        );
        return true; // async response
    }
    if (isSessionEstablished(message)) {
        // Secrets in flight: require a trusted extension-page sender, not just a
        // matching extension id.
        if (!isTrustedExtensionPage(sender)) {
            return false;
        }
        const accessToken = readString(message, "accessToken");
        const refreshToken = readString(message, "refreshToken");
        // establishSession validates the payload and, on malformed input,
        // rejects WITHOUT mutating any existing session (fail-closed). It does
        // not broadcast, so it never clobbers an in-flight ingest snapshot.
        establishSession(accessToken, refreshToken).then(sendResponse, () => {
            sendResponse({ ok: false, error: "session_established_failed" });
        });
        return true; // async response
    }
    if (isStartIngest(message)) {
        // Shared single-flight (see importInFlight): reject a second concurrent run.
        if (importInFlight) {
            sendResponse({ ok: false, error: "import_in_progress" });
            return false;
        }
        importInFlight = true;
        void handleStartIngest(message).finally(() => { importInFlight = false; });
        sendResponse({ ok: true });
        return false;
    }
    if (isStartImport(message)) {
        // A crawl reuses the coach's SOURCE session, so it may only be triggered by
        // one of THIS extension's own pages — an id match alone is not enough (a
        // compromised content script shares the id). Gate on the trusted-page shape.
        if (!isTrustedExtensionPage(sender)) {
            sendResponse({ ok: false, error: "untrusted_sender" });
            return false;
        }
        // Shared single-flight (see importInFlight): reject a second concurrent run.
        if (importInFlight) {
            sendResponse({ ok: false, error: "import_in_progress" });
            return false;
        }
        importInFlight = true;
        void handleStartImport(message).finally(() => { importInFlight = false; });
        sendResponse({ ok: true });
        return false;
    }
    if (isStartCapture(message)) {
        const tabId = readTabId(message);
        if (tabId === null) {
            sendResponse({ ok: false, error: "start_capture: missing tabId" });
            return false;
        }
        handleStartCapture(tabId).then(sendResponse, (err) => {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : "capture failed" });
        });
        return true; // async response
    }
    if (isStopCapture(message)) {
        const tabId = readTabId(message);
        if (tabId === null) {
            sendResponse({ ok: false, error: "stop_capture: missing tabId" });
            return false;
        }
        handleStopCapture(tabId).then(sendResponse, (err) => {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : "stop failed" });
        });
        return true; // async response
    }
    return false;
});

// Internal token-lifecycle API, re-exported from the single owner
// (shared/session.js) for the service-worker module graph + the test harness.
// Never exposed on any runtime message surface (§13.4), so this is not a
// token-leakage vector.
export { TGP_API_ORIGIN };
export { clearTokens, getAccessToken } from "./shared/session.js";
// Test-harness only: makeSourceFetch composes blueprint-declared (adapter) headers
// with the SOURCE bearer, and the bearer MUST win. Exported so a test can prove
// that spoof resistance directly against the real merge, not a reconstruction.
export { makeSourceFetch };
