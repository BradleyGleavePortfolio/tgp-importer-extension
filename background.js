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
import { logNetworkEvent } from "./shared/log.js";
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
    // Non-secret per-install id the progress DTO requires (random, not a fingerprint).
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
function makeSender(intent, onAuthLost, tally) {
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
        // Counted only after the ack, so the tally records what landed.
        tally?.set(entityType, (tally.get(entityType) ?? 0) + entities.length);
    };
}

// Engine word -> ScoutCompleteDto member -> popup state (no backend "complete"/
// "empty", so clean-but-zero settles "partial"). Absent key = cancelled (docs/TIER0_CONTRACT_INTEGRITY.md).
const OUTCOME = {
    complete: { terminal: "success", state: "ingest_succeeded" },
    partial: { terminal: "partial", state: "ingest_partial" },
    empty: { terminal: "partial", state: "ingest_empty" },
    failed: { terminal: "failed", state: "ingest_failed" },
};

// POST the terminal settlement (only DTO fields; forbidNonWhitelisted 400s any
// undeclared field). Refreshes the token once on a 401 and retries, same as
// sendEntities(), so a token merely expired since the last entity send can't
// false-report ingest_failed. Never calls onAuthLost/clearTokens — an
// unrefreshable token still surfaces as "complete 401" to the caller.
async function completeIngest(intent, outcome) {
    const body = { intent_id: intent.intentId, terminal_status: outcome.terminalStatus };
    if (outcome.finalCounts !== undefined && outcome.finalCounts !== null) body.final_counts = outcome.finalCounts;
    // Counts and status categories only — never a response body, URL, or PII.
    if (typeof outcome.errorSummary === "string" && outcome.errorSummary.length > 0) body.error_summary = outcome.errorSummary.slice(0, 2000);
    const attempt = async (token) => {
        try {
            return await fetchWithTimeout(fetch, `${TGP_API_ORIGIN}/api/scout/ingest/complete`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify(body),
            });
        }
        catch (err) {
            // Bounded: a hung complete must not pin the MV3 worker.
            throw isTimeout(err) ? new Error("complete_timeout") : err;
        }
    };
    let token = await getAccessToken();
    let res = await attempt(token);
    if (res.status === 401) {
        const refreshed = await refreshAccessToken();
        if (refreshed !== null) {
            res = await attempt(refreshed);
        }
    }
    // No ack, no claim: a non-2xx complete means the run did NOT finalise.
    if (!res.ok) {
        throw new Error(`complete ${res.status}`);
    }
}

// Best-effort settlement for a run that THREW, so the intent doesn't sit
// "running" forever. `finalCounts` (only what's already known to have landed,
// e.g. makeSender's tally) is omitted, not guessed, when absent. Never throws
// — a failed settlement POST is logged (PII-free), not silently swallowed.
function settleFailed(intent, errorSummary, finalCounts) {
    const outcome = { terminalStatus: OUTCOME.failed.terminal, errorSummary };
    if (finalCounts !== undefined && Object.keys(finalCounts).length > 0) {
        outcome.finalCounts = finalCounts;
    }
    return completeIngest(intent, outcome)
        .catch(() => logNetworkEvent("settlement_network_error"));
}

// ---- progress transport -----------------------------------------------------

// Read (or mint once) the device id. "" on a storage fault (progress is
// advisory — a fault silences reporting, never the import).
async function getDeviceId() {
    try {
        const stored = await chrome.storage.local.get(STORAGE_KEYS.deviceId);
        const existing = readString(stored, STORAGE_KEYS.deviceId);
        if (existing !== null && existing.length > 0) return existing;
        const minted = `ext-${crypto.randomUUID()}`;
        await chrome.storage.local.set({ [STORAGE_KEYS.deviceId]: minted });
        return minted;
    }
    catch {
        return "";
    }
}

// Bearer POST to /api/scout/progress. Rejects on non-2xx; the reporter
// swallows it (progress must never fail a run).
async function postProgress(body) {
    const token = await getAccessToken();
    const res = await fetchWithTimeout(fetch, `${TGP_API_ORIGIN}/api/scout/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`progress ${res.status}`);
    }
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

// The OS notification is often the ONLY surface a coach sees, so it must not say
// "complete" for an outcome the popup is about to flag.
const NOTIFY_SUFFIX = { empty: "found no records — check the popup.", partial: "finished incomplete — check the popup." };
function notifyOutcome(platform, engineStatus) {
    const message = `Import from ${platform} ${NOTIFY_SUFFIX[engineStatus] ?? "complete."}`;
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

    // The extractor keeps no tally of its own, so the sender keeps one for it.
    const tally = new Map();
    const sendEntities = makeSender(intent, () => {
        controller.abort();
        broadcastAuthRequired("session expired — please sign in again");
    }, tally);
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
        // Empty (not "success", as before) if the extractor emitted nothing — a
        // drifted adapter must not report 0 records as done, same as the replay path.
        const result = { status: tally.size === 0 ? "empty" : "complete", counts: Object.fromEntries(tally) };
        const outcome = OUTCOME[result.status];
        const detail = terminalDetail(result);
        settlementSent = true;
        await completeIngest(intent, { terminalStatus: outcome.terminal, finalCounts: result.counts, errorSummary: detail ?? undefined });
        broadcastStatus({ ...currentSnapshot, intent: { ...intent, status: outcome.state }, lastError: detail });
        notifyOutcome(platform, result.status);
    }
    catch (err) {
        // TGP-side auth loss already broadcast the friendly re-pair state; keep it.
        if (isTgpAuthLost(err)) {
            return;
        }
        const detail = err instanceof Error ? err.message : "import failed";
        // Same unsettled-intent defect as the replay path; no progress-channel
        // fallback here, so carry the already-ACKed tally into the settlement.
        if (!settlementSent) {
            await settleFailed(intent, detail, Object.fromEntries(tally));
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
            // Honour the source's pacing hint (bounded at parse time); unparseable
            // leaves it undefined and the engine falls back to exponential backoff.
            const hinted = parseRetryAfterMs(readHeader(res, "Retry-After"));
            if (hinted !== null) err.retryAfterMs = hinted;
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

    // A throw AFTER a settlement is a rejected complete, not an unsettled run.
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
        const outcome = OUTCOME[result.status];
        if (outcome === undefined) {
            // cancelled: only the TGP auth-loss callback below aborts this run, and
            // it already cleared the tokens a complete needs (see the doc).
            broadcastStatus({ ...currentSnapshot, intent: { ...intent, status: "ingest_failed" }, lastError: failDetail(result) });
            return;
        }
        const detail = terminalDetail(result);
        // Per-entity tally keyed by the progress stream's types, not the old
        // { pages, entities } shape (neither of which is an entity a coach has).
        const settlement = { terminalStatus: outcome.terminal, finalCounts: result.counts, errorSummary: detail ?? undefined };
        // Close the progress series before the intent goes terminal, or the
        // newest row reads as mid-crawl.
        await reporter.flush(null, detail ?? undefined);
        settlementSent = true;
        if (result.status === "failed") {
            // Best-effort, so this POST failing stays observable, not silent.
            await completeIngest(intent, settlement).catch(() => logNetworkEvent("settlement_network_error"));
            broadcastStatus({ ...currentSnapshot, intent: { ...intent, status: outcome.state }, lastError: detail });
            return;
        }
        // Still requires a backend ack: a throw here is ingest_failed, not success.
        await completeIngest(intent, settlement);
        broadcastStatus({ ...currentSnapshot, intent: { ...intent, status: outcome.state }, lastError: detail });
        notifyOutcome(platform, result.status);
    }
    catch (err) {
        // TGP auth loss already broadcast "session expired"; a complete now would
        // only 401, so it stays unsettled until a re-pair.
        if (isTgpAuthLost(err)) {
            return;
        }
        // Source auth loss is fail-closed but NOT a TGP logout: prompt a source re-login.
        const detail = isAuthLost(err)
            ? "source sign-in required — open your source platform and try again"
            : (err instanceof Error ? err.message : "import failed");
        // TGP session is still good, so the intent must be settled first.
        if (!settlementSent) {
            await reporter.flush(null, detail);
            await settleFailed(intent, detail);
        }
        broadcastStatus({ ...currentSnapshot, intent: { ...intent, status: "ingest_failed" }, lastError: detail });
    }
}

// One human/diagnostic line per outcome (counts/status only, never a response
// body or PII), or null when the run was wholly clean.
function terminalDetail(result) {
    if (result.status === "complete") {
        return null;
    }
    if (result.status === "empty") {
        return "no records found — 0 records with no errors, usually means the adapter is out of date. Nothing was changed.";
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
