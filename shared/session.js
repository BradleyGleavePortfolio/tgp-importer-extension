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
import {
  discardBody,
  fetchWithTimeout,
  isTimeout,
  readBoundedJson,
} from "./net.js";
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

// Identity of the ESTABLISHED session, as opposed to the version of its state:
// bumped only by establishSession/clearTokens, never by a refresh rotation
// (same session, new tokens). A caller that starts work under one session
// records this and can later ask whether that session is still the current
// one; obsolete work must stop rather than clear/expire an acknowledged
// replacement or resume under the replacement's credentials (S4-R3-A-02).
// A non-secret integer; never token material.
let sessionGeneration = 0;

// Coalesce concurrent refreshes so the same refresh token is never presented
// twice in parallel (backend reuse-detection would force a re-pair).
//
// The slot records the epoch the run SNAPSHOTTED under, written inside the
// state lock (`null` until then). An establish/clear that bumps the epoch
// detaches only a run whose recorded epoch is now stale — that run belongs to
// the previous session and its commit is fenced anyway, so callers for the NEW
// session must not join it. A run that has not snapshotted yet is queued behind
// the transition on the same lock, WILL read the new token and epoch, and
// therefore stays joinable: detaching it would let a second caller present the
// new refresh token in parallel (S4-R3-A-01 / S4-R3B-01). The slot is vacated
// in `finally` only by the run that owns it.
//
// A run may be BOUND to the session generation its caller's work belongs to
// (`expected`; `null` = unbound). The binding is evaluated under the state
// lock at snapshot time, BEFORE the refresh token is read: if the session was
// replaced or cleared while the run was queued behind that transition, the run
// presents nothing and yields null instead of consuming (and rotating) the
// replacement's refresh token on behalf of obsolete work (S4-R4-A-02). The
// generation the run actually snapshotted is recorded so a bound joiner can
// refuse a token minted for a different session.
/** @typedef {{ epoch: number | null, generation: number | null, expected: number | null, obsolete: boolean }} RefreshRun */
/** @typedef {{ promise: Promise<string | null>, run: RefreshRun }} RefreshSlot */
/** @type {RefreshSlot | null} */
let refreshInFlight = null;
function detachStaleRefresh() {
  if (
    refreshInFlight !== null &&
    refreshInFlight.run.epoch !== null &&
    refreshInFlight.run.epoch !== stateEpoch
  ) {
    refreshInFlight = null;
  }
}

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
  return withStateLock(clearUnderLock);
}

// Conditional variant for a caller that started work under a specific session
// (see getSessionGeneration): clears ONLY if that session is still the current
// one, evaluated under the same state serialization as establish/clear. Returns
// whether it cleared. `false` means the caller's session was already replaced
// or cleared by someone else — the caller's work is obsolete and it must not
// treat its own failure as this session's failure.
export function clearTokensIfSession(generation) {
  return withStateLock(async () => {
    if (generation !== sessionGeneration) {
      return false;
    }
    await clearUnderLock();
    return true;
  });
}

async function clearUnderLock() {
  stateEpoch += 1;
  sessionGeneration += 1;
  detachStaleRefresh();
  accessTokenInMemory = undefined;
  await chrome.storage.session.remove(REFRESH_TOKEN_KEY);
}

// Which established session is current. Callers bind long-running work to this
// value and re-check it before acting on that session (send, settle, clear).
// Monotonic, so a value equal to the current one proves no establish/clear
// happened in between; a rotation keeps it unchanged.
export function getSessionGeneration() {
  return sessionGeneration;
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
    sessionGeneration += 1;
    detachStaleRefresh();
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
//
// `expectedGeneration` (optional) binds the call to the session the caller's
// work started under (see getSessionGeneration). A bound call presents nothing
// and returns null once that session is no longer current — decided outside
// the lock on entry, under the lock at snapshot, and again on the token it
// would hand back — so obsolete work can neither refresh nor be handed the
// replacement's credentials. Legitimate same-session callers still coalesce
// onto one run. An unbound call (no argument) keeps the original semantics.
export async function refreshAccessToken(expectedGeneration) {
  const expected = Number.isInteger(expectedGeneration)
    ? expectedGeneration
    : null;
  // Bounded: each pass awaits a slot that vacates itself in `finally`; the
  // loop only re-enters when a different caller's run occupied the slot in
  // the meantime and this caller could not share it.
  for (;;) {
    if (expected !== null && expected !== sessionGeneration) {
      return null;
    }
    const slot = refreshInFlight ?? startRefreshRun(expected);
    if (!canJoinRun(slot.run, expected)) {
      // Another session's bound run holds the slot: wait for it to vacate,
      // never join it and never present a second token in parallel.
      await slot.promise.then(
        () => undefined,
        () => undefined,
      );
      continue;
    }
    const token = await slot.promise;
    if (expected !== null) {
      return slot.run.generation === expected ? token : null;
    }
    if (slot.run.obsolete) {
      // Unbound caller joined a run that stood down for its bound owner; the
      // current session may be perfectly refreshable, so run again.
      continue;
    }
    return token;
  }
}

/** @param {number | null} expected @returns {RefreshSlot} */
function startRefreshRun(expected) {
  /** @type {RefreshRun} */
  const run = { epoch: null, generation: null, expected, obsolete: false };
  /** @type {RefreshSlot} */
  const slot = {
    run,
    promise: refreshAccessTokenOnce(run).finally(() => {
      if (refreshInFlight === slot) refreshInFlight = null;
    }),
  };
  refreshInFlight = slot;
  return slot;
}

// A caller may share a run unless both are bound to different sessions.
/** @param {RefreshRun} run @param {number | null} expected */
function canJoinRun(run, expected) {
  return (
    run.expected === null || expected === null || run.expected === expected
  );
}

/** @param {RefreshRun} run */
async function refreshAccessTokenOnce(run) {
  const snapshot = await withStateLock(async () => {
    // Recorded inside the lock so a transition queued behind this snapshot
    // sees the epoch it must compare against (see detachStaleRefresh), and so
    // a bound joiner can tell which session this run minted for.
    run.epoch = stateEpoch;
    run.generation = sessionGeneration;
    if (run.expected !== null && run.expected !== sessionGeneration) {
      // The session this run was bound to was replaced/cleared while the run
      // was queued: stand down WITHOUT reading or presenting the current
      // session's refresh token (S4-R4-A-02).
      run.obsolete = true;
      return { token: null, epoch: stateEpoch };
    }
    const token = await readRefreshToken();
    return { token, epoch: stateEpoch };
  });
  if (snapshot.token === null) {
    return null;
  }

  // Headers AND body are consumed inside the one finite deadline. A refresh
  // whose JSON never finishes arriving must settle (null) like a hung connect,
  // so coalesced callers are released and can fail closed instead of pinning
  // the worker until teardown. Body bytes are bounded as well as time.
  let res;
  try {
    res = await fetchWithTimeout(
      fetch,
      REFRESH_ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: snapshot.token }),
      },
      undefined,
      async (response, signal) => {
        if (!response.ok) {
          // Not parsed (fixed categories only), but not left live either.
          discardBody(response);
          return { ok: false, body: null };
        }
        let body = null;
        try {
          body = await readBoundedJson(response, signal);
        } catch (err) {
          // A deadline abort mid-body is the timeout below, not a parse error.
          if (signal.aborted) throw err;
          logNetworkEvent("refresh_body_parse_error");
        }
        return { ok: true, body };
      },
    );
  } catch (err) {
    logNetworkEvent(
      isTimeout(err) ? "refresh_timeout" : "refresh_network_error",
    );
    return null;
  }
  if (!res.ok) {
    return null;
  }

  const body = res.body;
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
// no session exists so callers fail closed. `expectedGeneration` (optional)
// binds the cold-path refresh to the caller's session (see refreshAccessToken);
// the in-memory fast path is the caller's to check against getSessionGeneration.
export async function getAccessToken(expectedGeneration) {
  if (isNonEmptyString(accessTokenInMemory)) {
    return accessTokenInMemory;
  }
  const minted = await refreshAccessToken(expectedGeneration);
  if (minted === null) {
    throw new Error("no_session");
  }
  return minted;
}
