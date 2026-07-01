// TGP Importer — MV3 background service worker.
//
// Responsibilities (see docs/DESIGN.md §2, §4, §7, §10):
//   - On install: seed the storage schema + empty progress snapshot.
//   - On `start_ingest`: verify token, pick the extractor via detectPlatform,
//     wire sendEntities (bearer POST) + broadcastStatus (runtime message).
//   - On `request_status`: return the current snapshot.
//   - Token lifecycle: refresh access token on 401; if refresh also 401, clear
//     both tokens and broadcast `auth_required`.
//   - On completion: chrome.notifications + POST /api/scout/ingest/complete.
//   - On SW wake: rehydrate tokens from chrome.storage.local; do NOT resume an
//     in-flight run (runs are idempotent per source_id; the backend de-dupes on
//     source_id, so a re-emitted completed batch is harmless).
//
// R75: zero banned type-assertions — every narrowing is a real guard.
// R76: this file stays comfortably under 400 LOC.
import { TGP_API_ORIGIN } from "./shared/protocol.js";
import { detectPlatform } from "./extractors/detect.js";
import { TrueCoachExtractor } from "./extractors/truecoach.js";

// chrome.storage.local schema keys. The REFRESH token is persisted; the access
// token is memory-only (see §4) and never written here.
const STORAGE_KEYS = {
    refreshToken: "tgp_refresh_token",
    snapshot: "tgp_status_snapshot",
    schemaVersion: "tgp_schema_version",
};

// Memory-only access token. Undefined after a SW death; rehydrated lazily via
// the refresh endpoint on the first call that needs it.
let accessTokenInMemory;

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
function isRequestStatus(m) {
    return isRecord(m) && m.kind === "request_status";
}
function readString(record, key) {
    return isRecord(record) && typeof record[key] === "string" ? record[key] : null;
}

// ---- token lifecycle --------------------------------------------------------

async function readRefreshToken() {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.refreshToken);
    return readString(stored, STORAGE_KEYS.refreshToken);
}

async function clearTokens() {
    accessTokenInMemory = undefined;
    await chrome.storage.local.remove(STORAGE_KEYS.refreshToken);
}

// Mint a fresh access token from the stored refresh token. Returns null when no
// refresh token exists or the refresh call is rejected (caller handles auth).
async function refreshAccessToken() {
    const refreshToken = await readRefreshToken();
    if (refreshToken === null) {
        return null;
    }
    const res = await fetch(`${TGP_API_ORIGIN}/auth/extension/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) {
        return null;
    }
    const body = await res.json();
    const next = readString(body, "access_token");
    if (next === null) {
        return null;
    }
    accessTokenInMemory = next;
    // Honour refresh-token rotation when the backend returns a new one.
    const rotated = readString(body, "refresh_token");
    if (rotated !== null) {
        await chrome.storage.local.set({ [STORAGE_KEYS.refreshToken]: rotated });
    }
    return next;
}

// Return a usable access token, minting one from the refresh token if the
// in-memory copy is absent (cold SW wake). Throws when no session exists.
async function getAccessToken() {
    if (typeof accessTokenInMemory === "string" && accessTokenInMemory.length > 0) {
        return accessTokenInMemory;
    }
    const minted = await refreshAccessToken();
    if (minted === null) {
        throw new Error("no_session");
    }
    return minted;
}

// ---- ingest transport -------------------------------------------------------

// POST a batch to /api/scout/ingest with the bearer token. On 401, refresh once
// and retry. If the retry also 401s, invoke onAuthLost and stop.
function makeSender(intent, onAuthLost) {
    return async function sendEntities(entityType, entities) {
        const body = JSON.stringify({
            intent_id: intent.intentId,
            entity_type: entityType,
            entities: entities.map((e) => ({ source_id: e.sourceId, payload: e.payload })),
        });
        const attempt = async (token) => fetch(`${TGP_API_ORIGIN}/api/scout/ingest`, {
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
                throw new Error("auth_required");
            }
            token = refreshed;
            res = await attempt(token);
            if (res.status === 401) {
                await clearTokens();
                onAuthLost();
                throw new Error("auth_required");
            }
        }
        if (!res.ok) {
            throw new Error(`ingest ${entityType} -> ${res.status}`);
        }
    };
}

async function completeIngest(intent) {
    const token = await getAccessToken();
    await fetch(`${TGP_API_ORIGIN}/api/scout/ingest/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ intent_id: intent.intentId, platform: intent.platform }),
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

function notifyComplete(platform) {
    chrome.notifications.create({
        type: "basic",
        iconUrl: "popup/icon-128.png",
        title: "TGP Importer",
        message: `Import from ${platform} complete.`,
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

    try {
        await extractor.run({ token: sourceToken, signal: controller.signal });
        await completeIngest(intent);
        broadcastStatus({ ...currentSnapshot, intent: { ...intent, status: "ingest_succeeded" } });
        notifyComplete(platform);
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : "import failed";
        broadcastStatus({
            ...currentSnapshot,
            intent: { ...intent, status: "ingest_failed" },
            lastError: detail,
        });
    }
}

// ---- message router ---------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isRequestStatus(message)) {
        void rehydrateSnapshot().then(() => sendResponse(currentSnapshot));
        return true; // async response
    }
    if (isStartIngest(message)) {
        void handleStartIngest(message);
        sendResponse({ ok: true });
        return false;
    }
    return false;
});

export { TGP_API_ORIGIN, clearTokens };
