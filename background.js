// TGP Importer — MV3 background service worker.
//
// Responsibilities (see docs/DESIGN.md §2, §4, §7, §10):
//   - On install: seed the storage schema + empty progress snapshot.
//   - On `session_established`: hand the token pair to shared/session.js, the
//     single session-ownership boundary. The pairing view (popup/pair.js) is
//     the ONLY producer of this message.
//   - On `start_ingest` / `start_import`: confine the run to the ONE https
//     origin the coach authorized on Start (chrome.permissions.contains, held
//     in shared/session.js), pick the reader by registry lookup on that origin
//     (shared/replay/resolve.js; the quarantined oracle under legacy/ is the
//     only registrant), wire sendEntities (bearer POST) + broadcastStatus.
//   - Grant lifetime (final policy): the host grant is a SINGLE-USE Start
//     capability. The popup requests it on the Start gesture, the worker
//     consumes the fresh grant (permissions.onAdded) for exactly one run, and
//     the run's settlement revokes it and verifies the revocation. A grant
//     that merely exists is never a Start: it is revoked and refused
//     (`start_not_authorized`). A grant the coach withdraws mid-run ends the
//     run at once (`origin_revoked`). Nothing about the origin persists past
//     the run, in Chrome or in the extension.
//   - On `request_status` / `request_session_state`: return the snapshot / a
//     non-secret hasSession boolean.
//   - Token lifecycle lives entirely in shared/session.js (memory-only access
//     token, chrome.storage.session refresh token). On 401 mid-crawl we refresh
//     once; if that also fails we clear local token state + broadcast
//     `auth_required` — but only when the run's session is still the current
//     one; a run whose session was replaced meanwhile stops without touching
//     the replacement (there is no server logout endpoint yet — no revocation
//     is claimed).
//   - On completion: chrome.notifications + POST /api/scout/ingest/complete.
//   - On SW wake: the snapshot rehydrates from disk; credentials live in
//     memory / storage.session only, so a fresh pair may be required.
//     Do NOT resume an in-flight run (runs are idempotent per sourceId; the
//     backend de-dupes, so a re-emitted completed batch is harmless).
//
// R75: zero banned type-assertions — every narrowing is a real guard.
import {
  TGP_API_ORIGIN,
  isTgpOrigin,
  makeScoutIngestBody,
} from "./shared/protocol.js";
import { readIngestAcknowledgement } from "./shared/ingest-ack.js";
import {
  establishSession,
  hasActiveSession,
  getAccessToken,
  refreshAccessToken,
  clearTokensIfSession,
  getSessionGeneration,
  setAuthorizedOrigin,
  getAuthorizedOrigin,
  clearAuthorizedOrigin,
} from "./shared/session.js";
// The ONLY core import of the quarantined legacy oracle: it registers itself
// with the vendor-free registry and core never names it again.
import "./legacy/index.js";
import {
  runReplay,
  AuthLostError,
  isAuthLost,
} from "./shared/replay/engine.js";
import {
  resolveBlueprint,
  resolveExtractor,
  isUnknownPlatform,
} from "./shared/replay/resolve.js";
import {
  fetchWithTimeout,
  isTimeout,
  parseRetryAfterMs,
  readHeader,
} from "./shared/net.js";
import { createProgressReporter } from "./shared/progress.js";
import {
  IMPORT_STATUS_PATH,
  isSendableIntentId,
  readImportStatusReply,
  unavailableServerStatus,
} from "./shared/import-status.js";
import { logNetworkEvent } from "./shared/log.js";
import {
  attachDebugger,
  stopCapture,
  retireCaptureSessions,
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
/** @type {object} */
let currentSnapshot = emptySnapshot();

function emptySnapshot() {
  return {
    kind: "status_snapshot",
    intent: null,
    progress: [],
    lastError: null,
  };
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
function isRequestServerStatus(m) {
  return isRecord(m) && m.kind === "request_server_status";
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
  return isRecord(record) && typeof record[key] === "string"
    ? record[key]
    : null;
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

// The session a run started under was replaced (a new pairing was acknowledged)
// or cleared by someone else while the run was in flight. Distinct from auth
// loss: the CURRENT session is intact, so nothing is cleared and no
// `auth_required` is broadcast. The obsolete run stops and must not resume
// (send, settle, or report) under the replacement's credentials (S4-R3-A-02).
function tgpSessionReplaced() {
  const err = new Error("session_replaced");
  err.name = "TgpSessionReplacedError";
  return err;
}
function isTgpSessionReplaced(err) {
  return err instanceof Error && err.name === "TgpSessionReplacedError";
}
const SESSION_REPLACED_DETAIL =
  "import stopped — your TGP session changed during the import. Start the import again.";

// Bearer for work bound to the session `generation` (see getSessionGeneration).
// Throws TgpSessionReplacedError once that session is no longer the current
// one, so obsolete work never carries the replacement's token. The binding is
// carried INTO the cold-path refresh (the session module evaluates it under
// its state lock before presenting any refresh token) and re-checked on the
// way out: the generation is monotonic, so unchanged after the read means the
// token was minted for this session. A refresh that stood down or was fenced
// because the session moved surfaces as "replaced", not as "no session".
async function ownedAccessToken(generation) {
  if (getSessionGeneration() !== generation) {
    throw tgpSessionReplaced();
  }
  let token;
  try {
    token = await getAccessToken(generation);
  } catch (err) {
    if (getSessionGeneration() !== generation) {
      throw tgpSessionReplaced();
    }
    throw err;
  }
  if (getSessionGeneration() !== generation) {
    throw tgpSessionReplaced();
  }
  return token;
}

// Preflight for an accepted Start: the run is already bound to `generation`
// (captured synchronously at admission, before any await), so the token it
// verifies is the OWNING session's, never whichever session exists when the
// cold refresh returns (S4-R4-A-01). Returns the failure to report, or null to
// proceed. "login required" is broadcast ONLY when the run's own session is
// still current and could not mint; a session replaced during preflight is
// reported as such and the replacement is left untouched.
async function preflightOwnedSession(generation) {
  let accessToken;
  try {
    accessToken = await ownedAccessToken(generation);
  } catch (err) {
    if (isTgpSessionReplaced(err)) {
      return { replaced: true };
    }
    return { replaced: false };
  }
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { replaced: false };
  }
  return null;
}

// Final reporting authority for a preflight failure of the run bound to
// `generation`. The classification above was decided BEFORE an await boundary
// (the async preflight resolving back into the handler); a replacement whose
// establish was queued on the state lock can commit inside that gap, so the
// owner is revalidated SYNCHRONOUSLY here, immediately before any
// notification. A now-obsolete preflight reports "replaced" — never
// auth_required for a session that is not its own (S4-R5-A-01). Nothing of
// the current session is read, presented or cleared on either branch.
function reportPreflightFailure(failure, generation) {
  if (failure.replaced || getSessionGeneration() !== generation) {
    // The CURRENT session is intact: no auth_required, nothing cleared.
    broadcastStatus({ ...emptySnapshot(), lastError: SESSION_REPLACED_DETAIL });
    return;
  }
  // The run's OWN session is still current and could not mint: genuine.
  broadcastAuthRequired("login required to import");
}

// A run's terminal 401 becomes the right stop. The local session is cleared and
// routed to pairing ONLY when the run's session is still the current one
// (decided under the session module's state lock); otherwise an acknowledged
// replacement owns the tokens now and this run is merely obsolete.
async function sessionLossError(run) {
  const cleared = await clearTokensIfSession(run.generation);
  if (!cleared) {
    run.onObsolete();
    return tgpSessionReplaced();
  }
  run.onAuthLost();
  return tgpAuthLost();
}

// Stop an obsolete run before it presents or refreshes another session's
// tokens.
function obsoleteRunError(run) {
  run.onObsolete();
  return tgpSessionReplaced();
}

// POST a batch to /api/scout/ingest with the bearer token (finite timeout).
// On 401, refresh once and retry. If the retry also 401s, invoke onAuthLost
// and stop — unless the run's session was replaced meanwhile (see
// sessionLossError).
// `run` = { generation, onAuthLost, onObsolete }.
function makeSender(intent, run, tally, staging) {
  return async function sendEntities(entityType, entities) {
    // Entities pass through VERBATIM — each is the camelCase makeEntity()
    // envelope { sourceId, sourcePlatform, capturedAt, payload } that the
    // backend ScoutEntityDto validates 1:1 (R80-CLARIFY-1). Re-mapping or
    // renaming here would 400 every batch.
    const body = JSON.stringify(
      makeScoutIngestBody(intent.intentId, entityType, entities),
    );
    // One serialized batch is outstanding at a time. This count is NOT proof
    // of rejection: a missing reply may follow a successful server commit.
    broadcastStatus({
      ...currentSnapshot,
      pendingTransfer: { entityType, count: entities.length },
    });
    const attempt = async (token) =>
      fetchWithTimeout(
        fetch,
        `${TGP_API_ORIGIN}/api/scout/ingest`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body,
        },
        undefined,
        async (response) => ({
          ok: response.ok,
          status: response.status,
          ack: response.ok
            ? await readIngestAcknowledgement(response, entities.length)
            : null,
        }),
      );
    let token;
    try {
      token = await ownedAccessToken(run.generation);
    } catch (err) {
      if (isTgpSessionReplaced(err)) {
        run.onObsolete();
      }
      throw err;
    }
    let res = await attempt(token);
    if (res.status === 401) {
      // Never refresh (present the refresh token of) a session this run does
      // not own: checked here and, bound by `run.generation`, again under the
      // session module's state lock before the token is read.
      if (getSessionGeneration() !== run.generation) {
        throw obsoleteRunError(run);
      }
      const refreshed = await refreshAccessToken(run.generation);
      if (refreshed === null) {
        throw await sessionLossError(run);
      }
      // A token minted after a replacement landed belongs to the replacement.
      if (getSessionGeneration() !== run.generation) {
        throw obsoleteRunError(run);
      }
      token = refreshed;
      res = await attempt(token);
      if (res.status === 401) {
        throw await sessionLossError(run);
      }
    }
    if (!res.ok) {
      throw new Error(`ingest ${entityType} -> ${res.status}`);
    }
    // A 2xx alone proves nothing. Only a valid, bounded acknowledgement counts.
    // These are staging counters, NOT verified native or source-unique records.
    const { received, deduped } = res.ack;
    tally.set(entityType, (tally.get(entityType) ?? 0) + received);
    const previous = staging.get(entityType) ?? {
      received: 0,
      inserted: 0,
      deduped: 0,
    };
    staging.set(entityType, {
      received: previous.received + received,
      inserted: previous.inserted + received - deduped,
      deduped: previous.deduped + deduped,
    });
    broadcastStatus({
      ...currentSnapshot,
      staging: Object.fromEntries(staging),
      pendingTransfer: null,
    });
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
// unrefreshable token still surfaces as "complete 401" to the caller. Bound to
// the run's session `generation`: a replaced session throws
// TgpSessionReplacedError instead of settling the old intent with the new
// session's credentials.
async function completeIngest(intent, outcome, generation) {
  const body = {
    intent_id: intent.intentId,
    terminal_status: outcome.terminalStatus,
  };
  if (outcome.finalCounts !== undefined && outcome.finalCounts !== null)
    body.final_counts = outcome.finalCounts;
  // Counts and status categories only — never a response body, URL, or PII.
  if (
    typeof outcome.errorSummary === "string" &&
    outcome.errorSummary.length > 0
  )
    body.error_summary = outcome.errorSummary.slice(0, 2000);
  const attempt = async (token) => {
    try {
      return await fetchWithTimeout(
        fetch,
        `${TGP_API_ORIGIN}/api/scout/ingest/complete`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      // Bounded: a hung complete must not pin the MV3 worker.
      throw isTimeout(err) ? new Error("complete_timeout") : err;
    }
  };
  let token = await ownedAccessToken(generation);
  let res = await attempt(token);
  if (res.status === 401) {
    if (getSessionGeneration() !== generation) {
      throw tgpSessionReplaced();
    }
    const refreshed = await refreshAccessToken(generation);
    if (getSessionGeneration() !== generation) {
      throw tgpSessionReplaced();
    }
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
function settleFailed(intent, errorSummary, finalCounts, generation) {
  const outcome = { terminalStatus: OUTCOME.failed.terminal, errorSummary };
  if (finalCounts !== undefined && Object.keys(finalCounts).length > 0) {
    outcome.finalCounts = finalCounts;
  }
  return completeIngest(intent, outcome, generation).catch(
    logSettlementFailure,
  );
}

// A settlement that could not be sent is logged by category only. A run whose
// session was replaced is not a network fault: it is deliberately left
// unsettled rather than settled under the replacement's credentials.
function logSettlementFailure(err) {
  logNetworkEvent(
    isTgpSessionReplaced(err)
      ? "settlement_skipped_session_replaced"
      : "settlement_network_error",
  );
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
  } catch {
    return "";
  }
}

// Bearer POST to /api/scout/progress. Rejects on non-2xx; the reporter
// swallows it (progress must never fail a run). Bound to the run's session so
// an obsolete run never reports under the replacement's token.
async function postProgress(body, generation) {
  const token = await ownedAccessToken(generation);
  const res = await fetchWithTimeout(
    fetch,
    `${TGP_API_ORIGIN}/api/scout/progress`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`progress ${res.status}`);
  }
}

// ---- server status read (Check status) --------------------------------------

// Read-only: GET /api/scout/import/status for the worker's OWN recorded run id
// (never a caller-supplied id), with the current session's bearer. Mirrors
// completeIngest's auth handling: one refresh on 401, bound to the session
// generation captured here; never clears tokens, never broadcasts
// auth_required, never touches the snapshot, Start or run control. Any fault
// is "unavailable"; a 404 is "not yet known" (see shared/import-status.js).
async function handleRequestServerStatus() {
  const generation = getSessionGeneration();
  try {
    if (!importInFlight) await rehydrateSnapshot();
    const intentId = readString(
      Reflect.get(currentSnapshot, "intent"),
      "intentId",
    );
    if (!isSendableIntentId(intentId)) {
      return { kind: "server_status", state: "no_run" };
    }
    const url = `${TGP_API_ORIGIN}${IMPORT_STATUS_PATH}?intent_id=${encodeURIComponent(intentId)}`;
    const attempt = (token) =>
      fetchWithTimeout(
        fetch,
        url,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } },
        undefined,
        (response, signal) => readImportStatusReply(response, intentId, signal),
      );
    let res = await attempt(await ownedAccessToken(generation));
    if (res.http === 401) {
      const refreshed = await refreshAccessToken(generation);
      if (refreshed === null || getSessionGeneration() !== generation) {
        return { kind: "server_status", ...unavailableServerStatus() };
      }
      res = await attempt(refreshed);
    }
    return { kind: "server_status", ...res.reply };
  } catch {
    // No session, replaced session, timeout or transport fault: nothing is
    // known from the server, and no worker detail reaches the popup.
    return { kind: "server_status", ...unavailableServerStatus() };
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
  currentSnapshot = {
    ...emptySnapshot(),
    ...snapshot,
    kind: "status_snapshot",
  };
  void chrome.storage.local.set({ [STORAGE_KEYS.snapshot]: currentSnapshot });
  // Best-effort: the popup may be closed, in which case sendMessage rejects.
  chrome.runtime
    .sendMessage({ ...currentSnapshot, workerActive: importInFlight })
    .catch(() => logNetworkEvent("status_popup_unavailable"));
}

function broadcastAuthRequired(message) {
  broadcastStatus({
    ...emptySnapshot(),
    lastError: message ?? "auth_required",
  });
  chrome.runtime.sendMessage({ kind: "auth_required" }).catch(() => undefined);
}

// The OS notification is often the ONLY surface a coach sees, so it must not say
// "complete" for an outcome the popup is about to flag.
const NOTIFY_SUFFIX = {
  complete: "replay_notify_staged",
  empty: "found no records — check the popup.",
  partial: "finished incomplete — check the popup.",
};
function notifyOutcome(platform, engineStatus) {
  const message =
    engineStatus === "complete"
      ? chrome.i18n.getMessage(NOTIFY_SUFFIX.complete, [platform])
      : `Import from ${platform} ${NOTIFY_SUFFIX[engineStatus] ?? "needs review — check the popup."}`;
  chrome.notifications.create({
    type: "basic",
    iconUrl: "popup/icon-128.png",
    title: "TGP Importer",
    message,
  });
}

// ---- ingest run -------------------------------------------------------------

// ---- origin authorization (Authorization = Start) ---------------------------

// A Start authorization is a FRESH grant: Chrome only fires permissions.onAdded
// when the coach accepts its prompt, which chrome.permissions.request may show
// only from a user gesture. The worker records each freshly granted origin in
// memory and a run CONSUMES it (single use). A grant that merely exists — left
// over from a run whose revoke failed, or from a Start whose message was lost
// — is not a Start: it is revoked so the next Start prompts again.
const freshGrants = new Set();

// The https origins a chrome.permissions event names (patterns `origin/*`).
function grantedOrigins(permissions) {
  const patterns =
    isRecord(permissions) && Array.isArray(permissions.origins)
      ? permissions.origins
      : [];
  const origins = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    const origin = tabOriginAllowlist(pattern.replace(/\/\*$/, "/"))?.[0];
    if (origin !== undefined) origins.push(origin);
  }
  return origins;
}

chrome.permissions.onAdded.addListener((permissions) => {
  for (const origin of grantedOrigins(permissions)) freshGrants.add(origin);
});

// The run currently holding the authorization, so a revocation can reach it.
// Opened as soon as an origin is authorized (before any tab or network work),
// closed by settleRun.
/** @type {{ origin: string, controller: AbortController, revoked: boolean } | null} */
let activeRun = null;

function openRun(origin) {
  const run = { origin, controller: new AbortController(), revoked: false };
  activeRun = run;
  return run;
}

function revokedDetail(origin) {
  return `origin_revoked: ${origin}`;
}

// The coach withdrew the run's host grant (chrome://extensions, or another
// extension page) while the run was in flight: the run stops NOW, not at its
// next admission check. The crawl is aborted, the authorization is dropped so
// no capture session stays live, and the run reports `origin_revoked`. The
// worker's own revocation at settlement finds no active run and is a no-op.
chrome.permissions.onRemoved.addListener((permissions) => {
  const run = activeRun;
  if (run === null || run.revoked) return;
  if (!grantedOrigins(permissions).includes(run.origin)) return;
  run.revoked = true;
  freshGrants.delete(run.origin);
  clearAuthorizedOrigin();
  run.controller.abort();
  void retireCaptureSessions();
});

function grantPattern(origin) {
  return `${origin}/*`;
}

async function holdsGrant(origin) {
  try {
    return (
      (await chrome.permissions.contains({
        origins: [grantPattern(origin)],
      })) === true
    );
  } catch {
    return false;
  }
}

// Revoke an origin's host grant and confirm Chrome no longer holds it.
async function revokeGrant(origin) {
  try {
    await chrome.permissions.remove({ origins: [grantPattern(origin)] });
  } catch {
    return false;
  }
  return !(await holdsGrant(origin));
}

// The tab's https origin becomes the run's single authorized origin ONLY if it
// is not a TGP origin, Chrome holds the host permission, and that permission
// is a fresh Start grant (see freshGrants). The worker never trusts the
// popup's claim; it asks Chrome, and it consumes the grant.
async function authorizeSourceOrigin(url) {
  const origin = tabOriginAllowlist(url)?.[0] ?? null;
  if (origin === null) {
    return { error: `unsafe import origin: ${describedOrigin(url)}` };
  }
  if (isTgpOrigin(origin)) {
    return { error: `origin_is_tgp: ${origin}` };
  }
  if (!(await holdsGrant(origin))) {
    freshGrants.delete(origin);
    return { error: `origin_not_granted: ${origin}` };
  }
  if (!freshGrants.has(origin)) {
    // Possession of a durable permission is not a Start. Drop it so the coach
    // is prompted afresh next time.
    await revokeGrant(origin);
    return { error: `start_not_authorized: ${origin}` };
  }
  freshGrants.delete(origin);
  setAuthorizedOrigin(origin);
  return { origin };
}

// Not learned yet: no registered reader describes this origin.
function notLearned(origin) {
  return `site_not_learned: ${origin}`;
}

// Persisted/displayed error text carries the tab ORIGIN only: a full source URL
// can name a client in its path or query, and lastError is written to
// chrome.storage.local and rendered in the popup.
function describedOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "(invalid url)";
  }
}

async function handleStartIngest(message) {
  // The session this accepted Start belongs to, bound SYNCHRONOUSLY at
  // admission (the router calls this before yielding), before any await. Any
  // later establish/clear makes the run obsolete (see ownedAccessToken /
  // sessionLossError); the run never adopts a session that appears later.
  const generation = getSessionGeneration();
  const url = typeof message.url === "string" ? message.url : "";
  const authorized = await authorizeSourceOrigin(url);
  if (authorized.error !== undefined) {
    broadcastStatus({ ...emptySnapshot(), lastError: authorized.error });
    return;
  }
  const run = openRun(authorized.origin);
  // Reader by registry lookup on the authorized origin, resolved before the
  // TGP session is consulted so an unlearned site is never a sign-in problem.
  const resolved = resolveExtractor(authorized.origin, {
    sendEntities: (entityType, entities) => sendEntities(entityType, entities),
    broadcastStatus: (snap) =>
      broadcastStatus({ ...currentSnapshot, ...snap, intent }),
    now: () => new Date(),
  });
  if (resolved === null) {
    broadcastStatus({
      ...emptySnapshot(),
      lastError: notLearned(authorized.origin),
    });
    return;
  }
  // Verify the OWNING session has (or can mint) a TGP access token before
  // starting. The owner is re-checked synchronously at the report.
  const preflight = await preflightOwnedSession(generation);
  if (preflight !== null) {
    reportPreflightFailure(preflight, generation);
    return;
  }

  // The legacy entrypoint is held to the same source-token discipline as
  // start_import: the bearer comes from the authorized tab's document, never
  // from the message. A caller-supplied token starts nothing.
  if (message.sourceToken !== undefined) {
    broadcastStatus({
      ...emptySnapshot(),
      lastError: `source_token_not_accepted: ${authorized.origin}`,
    });
    return;
  }
  const collected = await collectSourceToken(
    readTabId(message),
    authorized.origin,
  );
  if (run.revoked) {
    broadcastStatus({
      ...emptySnapshot(),
      lastError: revokedDetail(authorized.origin),
    });
    return;
  }
  if (collected.error !== undefined) {
    broadcastStatus({ ...emptySnapshot(), lastError: collected.error });
    return;
  }
  const sourceToken = collected.token;

  const { controller } = run;
  const tally = new Map();
  const staging = new Map();
  const { platform, extractor } = resolved;
  const intent = {
    intentId: `ext-${Date.now()}`,
    platform,
    status: "ingest_started",
  };
  broadcastStatus({ ...emptySnapshot(), intent, progress: [] });

  // The extractor keeps no tally of its own, so the sender keeps one for it.
  const sendEntities = makeSender(
    intent,
    {
      generation,
      onAuthLost: () => {
        controller.abort();
        broadcastAuthRequired("session expired — please sign in again");
      },
      onObsolete: () => controller.abort(),
    },
    tally,
    staging,
  );

  let settlementSent = false;
  try {
    await extractor.run({ token: sourceToken, signal: controller.signal });
    // Empty (not "success", as before) if the extractor emitted nothing — a
    // drifted adapter must not report 0 records as done, same as the replay path.
    const result = {
      status: tally.size === 0 ? "empty" : "complete",
      counts: Object.fromEntries(tally),
    };
    const outcome = OUTCOME[result.status];
    const detail = terminalDetail(result);
    settlementSent = true;
    await completeIngest(
      intent,
      {
        terminalStatus: outcome.terminal,
        finalCounts: result.counts,
        errorSummary: detail ?? undefined,
      },
      generation,
    );
    broadcastStatus({
      ...currentSnapshot,
      intent: { ...intent, status: outcome.state },
      lastError: detail,
    });
    notifyOutcome(platform, result.status);
  } catch (err) {
    // TGP-side auth loss already broadcast the friendly re-pair state; keep it.
    if (isTgpAuthLost(err)) {
      return;
    }
    // Session replaced mid-run: the current session is intact (nothing cleared,
    // no auth_required) and the old intent is not settled under it.
    if (isTgpSessionReplaced(err)) {
      broadcastStatus({
        ...currentSnapshot,
        intent: { ...intent, status: "ingest_failed" },
        lastError: SESSION_REPLACED_DETAIL,
      });
      return;
    }
    // A grant withdrawn mid-run is the honest stop, not the abort it caused.
    const detail = run.revoked
      ? revokedDetail(authorized.origin)
      : err instanceof Error
        ? err.message
        : "import failed";
    // Same unsettled-intent defect as the replay path; no progress-channel
    // fallback here, so carry the already-ACKed tally into the settlement.
    if (!settlementSent) {
      await settleFailed(intent, detail, Object.fromEntries(tally), generation);
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

// Cleanup the last run still owes. While set, no run is admitted: the next
// Start retries the cleanup and is refused until every step is verified.
/** @type {{ origin: string | null } | null} */
let pendingCleanup = null;

// A run's authorization ends with the run, in this order: every capture
// debugger is retired (no event or stop can outlive the run), the authorized
// origin is dropped, the collector registration is removed and VERIFIED gone,
// the origin's host grant is revoked and VERIFIED gone, and only then is the
// single-flight guard released. Any failed step keeps the guard closed
// (pendingCleanup) — cleanup is never assumed. Never throws.
async function settleRun() {
  // A revoked run already dropped its origin; its grant is still cleaned up.
  const origin = activeRun?.origin ?? getAuthorizedOrigin();
  activeRun = null;
  await retireCaptureSessions();
  clearAuthorizedOrigin();
  const clean = await cleanUp(origin);
  pendingCleanup = clean ? null : { origin };
  if (!clean) {
    logNetworkEvent("run_cleanup_pending");
  }
  importInFlight = !clean;
}

async function cleanUp(origin) {
  const collectorGone = await unregisterSourceCollector();
  const grantGone = origin === null ? true : await revokeGrant(origin);
  return collectorGone && grantGone;
}

// Retry the cleanup a previous run left pending; admits new runs once verified.
async function retryPendingCleanup() {
  if (pendingCleanup === null) return;
  const { origin } = pendingCleanup;
  if (await cleanUp(origin)) {
    pendingCleanup = null;
    importInFlight = false;
  }
}

// Confine the crawl to the origin the coach is looking at: the observed tab
// origin (https only) is the injected SSRF allowlist the blueprint's apiBase must
// match. Never a hardcoded competitor map — site-agnostic by construction.
function tabOriginAllowlist(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === "https:" ? [u.origin] : null;
}

// Build the injected fetchJson the engine calls per page: carries the SOURCE bearer
// + in-tab cookies. A source 401/403 maps to AuthLostError so the run fails closed
// WITHOUT clearTokens() — source auth loss never clears the TGP tokens.
function makeSourceFetch(sourceToken) {
  return async function fetchJson(
    url,
    { method, headers: injected, signal, timeoutMs },
  ) {
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
    return fetchWithTimeout(
      fetch,
      url,
      { method, headers, credentials: "include", redirect: "error", signal },
      timeoutMs,
      async (res) => {
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
        } catch (cause) {
          if (!(cause instanceof SyntaxError)) throw cause;
          const err = new Error("source_bad_json");
          err.name = "MalformedResponseError";
          throw err;
        }
      },
    );
  };
}

// The classic collector (content/main.js) is not declared in the manifest: it
// is registered for the ONE granted origin for the run only, and injected into
// the already-loaded tab (a registration applies to future loads). Both calls
// need the host permission the coach granted on Start.
const SOURCE_COLLECTOR_ID = "tgp-source-collector";
const SOURCE_COLLECTOR_SCRIPT = "content/main.js";

async function registerSourceCollector(origin, tabId) {
  if (!(await unregisterSourceCollector())) {
    throw new Error("source_collector_stale");
  }
  await chrome.scripting.registerContentScripts([
    {
      id: SOURCE_COLLECTOR_ID,
      matches: [`${origin}/*`],
      js: [SOURCE_COLLECTOR_SCRIPT],
      runAt: "document_idle",
      persistAcrossSessions: false,
    },
  ]);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [SOURCE_COLLECTOR_SCRIPT],
  });
}

// Remove the collector registration and VERIFY it is gone. A missing
// registration is not a fault; a Chrome API failure is reported as `false` so
// the caller fails closed (settleRun keeps the guard; register refuses).
async function unregisterSourceCollector() {
  try {
    const before = await chrome.scripting.getRegisteredContentScripts({
      ids: [SOURCE_COLLECTOR_ID],
    });
    if (before.length > 0) {
      await chrome.scripting.unregisterContentScripts({
        ids: [SOURCE_COLLECTOR_ID],
      });
    }
    const after = await chrome.scripting.getRegisteredContentScripts({
      ids: [SOURCE_COLLECTOR_ID],
    });
    return after.length === 0;
  } catch {
    logNetworkEvent("source_collector_unregister_failed");
    return false;
  }
}

// The tab's live document origin, or null when the tab is gone / not https.
async function liveTabOrigin(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tabOriginAllowlist(readString(tab, "url"))?.[0] ?? null;
  } catch {
    return null;
  }
}

// Obtain the SOURCE bearer from the coach's own tab WITHOUT exposing it to
// popup/storage/logs/payload. The token is bound to ONE document on the
// authorized origin: the tab is checked before the collector is injected,
// again after every await (a navigation during injection or collection fails
// the run), and the collector's reply must name the document origin it read
// from. Returns { token } ("" when the page holds none) or { error }.
async function collectSourceToken(tabId, origin) {
  if (typeof tabId !== "number") {
    return { token: "" };
  }
  const navigated = `source_tab_navigated: ${origin}`;
  if ((await liveTabOrigin(tabId)) !== origin) {
    return { error: navigated };
  }
  let reply;
  try {
    await registerSourceCollector(origin, tabId);
    if ((await liveTabOrigin(tabId)) !== origin) {
      return { error: navigated };
    }
    reply = await chrome.tabs.sendMessage(tabId, {
      kind: "collect_source_token",
    });
  } catch {
    return { token: "" }; // no collector / port closed — fails closed downstream
  }
  if ((await liveTabOrigin(tabId)) !== origin) {
    return { error: navigated };
  }
  if (!isRecord(reply) || reply.ok !== true) {
    return { token: "" };
  }
  // A token from any other document is refused outright, never "no token".
  if (reply.origin !== origin || typeof reply.token !== "string") {
    return { error: navigated };
  }
  return { token: reply.token };
}

async function handleStartImport(message) {
  // The session this accepted Start belongs to, bound SYNCHRONOUSLY at
  // admission (the router calls this before yielding), before any await. Any
  // later establish/clear makes the run obsolete (see ownedAccessToken /
  // sessionLossError); the run never adopts a session that appears later.
  const generation = getSessionGeneration();
  const url = typeof message.url === "string" ? message.url : "";
  const authorized = await authorizeSourceOrigin(url);
  if (authorized.error !== undefined) {
    broadcastStatus({ ...emptySnapshot(), lastError: authorized.error });
    return;
  }
  const run = openRun(authorized.origin);
  // Crawl confinement: the run's ONE authorized origin is the injected SSRF
  // allowlist the blueprint's apiBase must match (normalizeBlueprint).
  const allowedOrigins = [authorized.origin];
  let blueprint;
  try {
    blueprint = resolveBlueprint(authorized.origin);
  } catch (err) {
    const detail = isUnknownPlatform(err)
      ? notLearned(authorized.origin)
      : "blueprint resolve failed";
    broadcastStatus({ ...emptySnapshot(), lastError: detail });
    return;
  }
  const platform =
    typeof blueprint.platform === "string"
      ? blueprint.platform
      : new URL(authorized.origin).hostname;
  // A TGP access token of the OWNING session is required for ingest before we
  // start crawling. The owner is re-checked synchronously at the report.
  const preflight = await preflightOwnedSession(generation);
  if (preflight !== null) {
    reportPreflightFailure(preflight, generation);
    return;
  }

  // Real source bearer from the coach's own tab; absent -> "" -> fails closed.
  // A tab that left the authorized origin starts nothing.
  const collected = await collectSourceToken(message.tabId, authorized.origin);
  if (run.revoked) {
    broadcastStatus({
      ...emptySnapshot(),
      lastError: revokedDetail(authorized.origin),
    });
    return;
  }
  if (collected.error !== undefined) {
    broadcastStatus({ ...emptySnapshot(), lastError: collected.error });
    return;
  }
  const sourceToken = collected.token;

  const { controller } = run;
  const intent = {
    intentId: `imp-${Date.now()}`,
    platform,
    status: "ingest_started",
  };
  broadcastStatus({ ...emptySnapshot(), intent, progress: [] });

  const tally = new Map();
  const staging = new Map();
  const sendEntities = makeSender(
    intent,
    {
      generation,
      onAuthLost: () => {
        // TGP-side auth loss: makeSender already cleared the tokens; route to
        // pairing.
        controller.abort();
        broadcastAuthRequired("session expired — please sign in again");
      },
      // Session replaced/cleared by someone else: stop crawling; the catch
      // below reports it without touching the current session.
      onObsolete: () => controller.abort(),
    },
    tally,
    staging,
  );
  const reporter = createProgressReporter({
    postProgress: (body) => postProgress(body, generation),
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
    if (outcome === undefined && run.revoked) {
      // cancelled because the coach withdrew the grant: the TGP session is
      // intact, so the intent is settled failed with the honest reason.
      const detail = revokedDetail(authorized.origin);
      await reporter.flush(null, detail);
      settlementSent = true;
      await settleFailed(intent, detail, Object.fromEntries(tally), generation);
      broadcastStatus({
        ...currentSnapshot,
        intent: { ...intent, status: "ingest_failed" },
        lastError: detail,
      });
      return;
    }
    if (outcome === undefined) {
      // cancelled: only the run's own callbacks abort it (TGP auth loss, which
      // already cleared the tokens a complete needs, or a replaced session,
      // whose tokens this run must not use), so it stays unsettled.
      broadcastStatus({
        ...currentSnapshot,
        intent: { ...intent, status: "ingest_failed" },
        lastError: failDetail(result),
      });
      return;
    }
    const detail = terminalDetail(result);
    // Per-entity tally keyed by the progress stream's types, not the old
    // { pages, entities } shape (neither of which is an entity a coach has).
    const settlement = {
      terminalStatus: outcome.terminal,
      finalCounts: result.counts,
      errorSummary: detail ?? undefined,
    };
    // Close the progress series before the intent goes terminal, or the
    // newest row reads as mid-crawl.
    await reporter.flush(null, detail ?? undefined);
    settlementSent = true;
    if (result.status === "failed") {
      // Best-effort, so this POST failing stays observable, not silent.
      await completeIngest(intent, settlement, generation).catch(
        logSettlementFailure,
      );
      broadcastStatus({
        ...currentSnapshot,
        intent: { ...intent, status: outcome.state },
        lastError: detail,
      });
      return;
    }
    // Still requires a backend ack: a throw here is ingest_failed, not success.
    await completeIngest(intent, settlement, generation);
    broadcastStatus({
      ...currentSnapshot,
      intent: { ...intent, status: outcome.state },
      lastError: detail,
    });
    notifyOutcome(platform, result.status);
  } catch (err) {
    // TGP auth loss already broadcast "session expired"; a complete now would
    // only 401, so it stays unsettled until a re-pair.
    if (isTgpAuthLost(err)) {
      return;
    }
    // The session this run started under was replaced (a new pairing was
    // acknowledged) or cleared meanwhile. The CURRENT session is intact:
    // nothing is cleared, no auth_required, and the old intent is NOT settled
    // or reported under the replacement's credentials. It stays unsettled,
    // like the auth-loss case.
    if (isTgpSessionReplaced(err)) {
      broadcastStatus({
        ...currentSnapshot,
        intent: { ...intent, status: "ingest_failed" },
        lastError: SESSION_REPLACED_DETAIL,
      });
      return;
    }
    // Source auth loss is fail-closed but NOT a TGP logout: prompt a source re-login.
    // A grant withdrawn mid-run is the honest stop, not the abort it caused.
    const detail = run.revoked
      ? revokedDetail(authorized.origin)
      : isAuthLost(err)
        ? "source sign-in required — open your source platform and try again"
        : err instanceof Error
          ? err.message
          : "import failed";
    // TGP session is still good, so the intent must be settled first.
    if (!settlementSent) {
      await reporter.flush(null, detail);
      await settleFailed(intent, detail, Object.fromEntries(tally), generation);
    }
    broadcastStatus({
      ...currentSnapshot,
      intent: { ...intent, status: "ingest_failed" },
      lastError: detail,
    });
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
  if (result.degraded === true)
    parts.push(chrome.i18n.getMessage("replay_partial_skipped"));
  if (result.truncated === true) {
    const reasons = result.truncationReasons;
    if (reasons.includes("budget"))
      parts.push(chrome.i18n.getMessage("replay_partial_budget"));
    if (reasons.includes("pagination_cycle"))
      parts.push(chrome.i18n.getMessage("replay_partial_pagination_cycle"));
    if (reasons.includes("page_ceiling"))
      parts.push(chrome.i18n.getMessage("replay_partial_page_ceiling"));
  }
  const why =
    parts.length > 0
      ? parts.join("; ")
      : chrome.i18n.getMessage("replay_partial_incomplete");
  return chrome.i18n.getMessage("replay_partial_summary", [
    why,
    String(result.entities),
  ]);
}
function failDetail(result) {
  if (result.status === "cancelled") return "import cancelled";
  const s = result.lastSkipStatus;
  return typeof s === "number" || typeof s === "string"
    ? `import failed — source responded ${s}`
    : "import failed";
}

// ---- capture control --------------------------------------------------------

// Wire the MV3 cleanup paths (tab close, debugger detach, SW suspend) once at
// service-worker startup so a capture session never leaks its debugger handle or
// buffer when it ends outside an explicit stop_capture.
registerCaptureLifecycle();

// A collector registration is run-scoped, but Chrome keeps a
// persistAcrossSessions:false registration until the BROWSER restarts, so a
// worker that died mid-run (or was recycled by Chrome) would leave the previous
// worker's collector injecting into every page load on that origin. No run can
// be in flight when this module evaluates, so the registration is removed here
// and verified gone; a failure keeps the Start gate closed until a retry
// succeeds (cleanup_pending), exactly like a failed settlement.
void unregisterSourceCollector().then((gone) => {
  if (!gone && pendingCleanup === null) {
    pendingCleanup = { origin: null };
  }
});

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
    // Live in-memory work wins over an older asynchronous disk write. Worker
    // liveness is returned, never persisted as evidence that a run is active.
    const ready = importInFlight ? Promise.resolve() : rehydrateSnapshot();
    void ready.then(() =>
      sendResponse({ ...currentSnapshot, workerActive: importInFlight }),
    );
    return true; // async response
  }
  if (isRequestServerStatus(message)) {
    // Spends the TGP bearer, so only this extension's own pages may ask.
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({ ok: false, error: "untrusted_sender" });
      return false;
    }
    void handleRequestServerStatus().then(sendResponse);
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
    // Legacy entrypoint accepts a caller-supplied token/url: same trusted-page
    // gate as start_import, so a content-script principal cannot drive it.
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({ ok: false, error: "untrusted_sender" });
      return false;
    }
    if (pendingCleanup !== null) {
      void retryPendingCleanup();
      sendResponse({ ok: false, error: "cleanup_pending" });
      return false;
    }
    // Shared single-flight (see importInFlight): reject a second concurrent run.
    if (importInFlight) {
      sendResponse({ ok: false, error: "import_in_progress" });
      return false;
    }
    importInFlight = true;
    void handleStartIngest(message).finally(settleRun);
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
    if (pendingCleanup !== null) {
      void retryPendingCleanup();
      sendResponse({ ok: false, error: "cleanup_pending" });
      return false;
    }
    // Shared single-flight (see importInFlight): reject a second concurrent run.
    if (importInFlight) {
      sendResponse({ ok: false, error: "import_in_progress" });
      return false;
    }
    importInFlight = true;
    void handleStartImport(message).finally(settleRun);
    sendResponse({ ok: true });
    return false;
  }
  if (isStartCapture(message) || isStopCapture(message)) {
    // chrome.debugger attach/detach and captured entries are for this
    // extension's own pages only, never a content-script principal.
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({ ok: false, error: "untrusted_sender" });
      return false;
    }
  }
  if (isStartCapture(message)) {
    const tabId = readTabId(message);
    if (tabId === null) {
      sendResponse({ ok: false, error: "start_capture: missing tabId" });
      return false;
    }
    handleStartCapture(tabId).then(sendResponse, (err) => {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : "capture failed",
      });
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
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : "stop failed",
      });
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
