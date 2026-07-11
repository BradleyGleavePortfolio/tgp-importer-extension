// TGP Importer — session & token lifecycle (the single ownership boundary).
//
// This module is the SOLE owner of extension session state (docs/DESIGN.md §4).
// The access token lives in memory only; the refresh token is persisted to
// chrome.storage.session — a trusted, browser-session-scoped store that
// survives service-worker restarts but is cleared on browser restart
// (intentional re-pair from the mobile app). Nothing here is ever written to
// disk-persisted storage (.local / .sync). No token value is ever logged,
// broadcast, or returned to a caller.
//
// Establish/clear are serialized through one mutex so two concurrent
// transitions can never interleave and leave a torn access/refresh pair; the
// last transition to run wins fully.
//
// R75: zero banned type-assertions — every narrowing is a real guard.
import { TGP_API_ORIGIN } from "./protocol.js";

// The one persisted secret. Lives only in chrome.storage.session.
export const REFRESH_TOKEN_KEY = "tgp_refresh_token";
const REFRESH_ENDPOINT = `${TGP_API_ORIGIN}/auth/extension/refresh`;

// Memory-only access token. Undefined after a service-worker death; rehydrated
// lazily from the refresh token on the first call that needs it.
let accessTokenInMemory;

// Serializes establish/clear. Each transition chains onto the previous one so
// they apply atomically relative to each other; a rejected transition never
// breaks the chain for the next.
let stateLock = Promise.resolve();
function withStateLock(work) {
    const run = stateLock.then(work, work);
    stateLock = run.then(() => undefined, () => undefined);
    return run;
}

function readString(record, key) {
    return typeof record === "object" && record !== null && typeof record[key] === "string"
        ? record[key]
        : null;
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}

async function readRefreshToken() {
    const stored = await chrome.storage.session.get(REFRESH_TOKEN_KEY);
    return readString(stored, REFRESH_TOKEN_KEY);
}

// Whether a session is recoverable without re-pairing: the access token is in
// memory, or a refresh token is persisted. Returns ONLY a boolean — never token
// material — so it is safe to answer to the popup for routing/observability.
export async function hasActiveSession() {
    if (isNonEmptyString(accessTokenInMemory)) {
        return true;
    }
    return (await readRefreshToken()) !== null;
}

// Drop all token state (logout-style cleanup / uninstall). This does NOT call
// any server revocation endpoint: none is built (docs/DESIGN.md §4,
// /auth/extension/logout is a backend dependency), so this clears LOCAL state
// only and makes no revocation guarantee.
export function clearTokens() {
    return withStateLock(async () => {
        accessTokenInMemory = undefined;
        await chrome.storage.session.remove(REFRESH_TOKEN_KEY);
    });
}

// The one authoritative "no session -> session" transition. Persists the
// refresh token FIRST; the access token only becomes live on a successful
// persist, so a persist failure leaves any PRIOR valid session fully intact
// (no asymmetric wipe). Returns a non-secret result and never touches the
// ingest status snapshot. Malformed input is rejected before the lock, so it
// cannot clobber an existing session.
export function establishSession(accessToken, refreshToken) {
    if (!isNonEmptyString(accessToken) || !isNonEmptyString(refreshToken)) {
        return Promise.resolve({ ok: false, error: "invalid_token_payload" });
    }
    return withStateLock(async () => {
        try {
            await chrome.storage.session.set({ [REFRESH_TOKEN_KEY]: refreshToken });
        }
        catch {
            return { ok: false, error: "session_persist_failed" };
        }
        accessTokenInMemory = accessToken;
        return { ok: true };
    });
}

// Mint a fresh access token from the stored refresh token. Returns null when no
// refresh token exists or the refresh call is rejected (caller fails closed).
export async function refreshAccessToken() {
    const refreshToken = await readRefreshToken();
    if (refreshToken === null) {
        return null;
    }
    const res = await fetch(REFRESH_ENDPOINT, {
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
        await chrome.storage.session.set({ [REFRESH_TOKEN_KEY]: rotated });
    }
    return next;
}

// Return a usable access token, minting one from the refresh token if the
// in-memory copy is absent (cold service-worker wake). Throws "no_session" when
// no session exists so callers fail closed.
export async function getAccessToken() {
    if (isNonEmptyString(accessTokenInMemory)) {
        return accessTokenInMemory;
    }
    const minted = await refreshAccessToken();
    if (minted === null) {
        throw new Error("no_session");
    }
    return minted;
}
