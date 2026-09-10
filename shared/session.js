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
// Establish, clear, AND the commit half of refresh are serialized through one
// mutex so two concurrent transitions can never interleave and leave a torn
// access/refresh pair; the last transition to run wins fully. Every mutating
// transition bumps a monotonic epoch. refreshAccessToken reads the refresh
// token under the lock, does its network call OUTSIDE the lock (so a slow
// refresh never blocks a logout), then re-enters the lock to commit ONLY if the
// epoch is unchanged — so a logout (clearTokens) that lands mid-refresh can
// never be followed by a stale refresh resurrecting the session.
//
// R75: zero banned type-assertions — every narrowing is a real guard.
import { TGP_API_ORIGIN } from "./protocol.js";
import { fetchWithTimeout, isTimeout } from "./net.js";
import { logNetworkEvent } from "./log.js";

// The one persisted secret. Lives only in chrome.storage.session.
export const REFRESH_TOKEN_KEY = "tgp_refresh_token";
// The backend's global `api` prefix does NOT exclude `auth`, so the real route is
// /api/auth/extension/refresh. Without it every refresh 404s and a valid refresh
// token in storage.session is unredeemable — silently forcing a re-pair on every
// cold service-worker wake.
const REFRESH_ENDPOINT = `${TGP_API_ORIGIN}/api/auth/extension/refresh`;

// Memory-only access token. Undefined after a service-worker death; rehydrated
// lazily from the refresh token on the first call that needs it.
let accessTokenInMemory;

// Monotonic version of the session state. Bumped inside the lock on every
// establish/clear so an in-flight refresh can detect that the state changed
// underneath it and refuse to commit (compare-and-swap on transition, not on
// token value — robust even if the same token string recurs).
let stateEpoch = 0;

// Coalesce concurrent cold-wake refreshes so the same refresh token is never
// presented twice in parallel (backend reuse-detection would force a re-pair).
let refreshInFlight = null;

// Serializes state transitions. Each transition chains onto the previous one so
// they apply atomically relative to each other; a rejected transition never
// breaks the chain for the next.
let stateLock = Promise.resolve();
/** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
function withStateLock(work) {
  const run = stateLock.then(work, work);
  stateLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function readString(record, key) {
  return typeof record === "object" &&
    record !== null &&
    typeof record[key] === "string"
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
    stateEpoch += 1;
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
    } catch {
      return { ok: false, error: "session_persist_failed" };
    }
    stateEpoch += 1;
    accessTokenInMemory = accessToken;
    return { ok: true };
  });
}

// Mint a fresh access token from the stored refresh token. Returns null when no
// refresh token exists, the refresh call fails/times out, or a concurrent
// logout/re-establish invalidated the in-flight refresh (caller fails closed).
//
// Split across the state lock: snapshot (token + epoch) under the lock, network
// OUTSIDE the lock (a hung refresh must never block a logout), commit under the
// lock ONLY if the epoch is unchanged. Rotation persistence is failure-safe: if
// persisting a rotated refresh token throws, we DO NOT publish the new access
// token — the prior session state is preserved and the caller fails closed,
// exactly as establishSession does (no asymmetric wipe / no torn pair).
export async function refreshAccessToken() {
  if (refreshInFlight !== null) {
    return refreshInFlight;
  }
  refreshInFlight = refreshAccessTokenOnce().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refreshAccessTokenOnce() {
  const snapshot = await withStateLock(async () => ({
    token: await readRefreshToken(),
    epoch: stateEpoch,
  }));
  if (snapshot.token === null) {
    return null;
  }

  let res;
  try {
    res = await fetchWithTimeout(fetch, REFRESH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: snapshot.token }),
    });
  } catch (err) {
    logNetworkEvent(
      isTimeout(err) ? "refresh_timeout" : "refresh_network_error",
    );
    return null;
  }
  if (!res.ok) {
    return null;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    logNetworkEvent("refresh_body_parse_error");
    return null;
  }
  const next = readString(body, "access_token");
  if (next === null) {
    return null;
  }
  const rotated = readString(body, "refresh_token");

  // Commit under the lock. If the epoch moved (a logout or a newer establish
  // ran while we were on the network) discard the result — never resurrect a
  // cleared session, never clobber a newer one.
  return withStateLock(async () => {
    if (snapshot.epoch !== stateEpoch) {
      return null;
    }
    if (rotated !== null) {
      try {
        await chrome.storage.session.set({ [REFRESH_TOKEN_KEY]: rotated });
      } catch {
        logNetworkEvent("refresh_rotation_persist_failed");
        return null;
      }
      stateEpoch += 1;
    }
    accessTokenInMemory = next;
    return next;
  });
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
