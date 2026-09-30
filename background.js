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
// The popup reporting that the grant its pending Start needed never arrived
// (the coach declined Chrome's prompt, or no prompt could be shown).
function isStartUnavailable(m) {
  return isRecord(m) && m.kind === "start_unavailable";
}
// The popup reporting that Chrome answered its permission request `true`.
function isStartGranted(m) {
  return isRecord(m) && m.kind === "start_granted";
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

// One terminal POST attempt. Resolves `true` when the backend ACKNOWLEDGED
// the terminal, else the Error the attempt ended with (lost reply, timeout,
// refused, session replaced) — logged by category, never thrown. The caller
// must not read a non-ack as "the run failed": the backend may have committed
// the terminal and only the reply was lost (S1-A2), so the caller asks the
// server (showAuthoritativeTerminal) instead of inferring anything.
async function attemptComplete(intent, outcome, generation) {
  try {
    await completeIngest(intent, outcome, generation);
    return true;
  } catch (err) {
    logSettlementFailure(err);
    return err instanceof Error ? err : new Error("complete_failed");
  }
}

// Settlement POST for a run that THREW or was ended from outside, so the intent
// doesn't sit "running" forever. `finalCounts` (only what's already known to
// have landed, e.g. makeSender's tally) is omitted, not guessed, when absent.
// Resolves like attemptComplete; never throws.
function settleFailed(intent, errorSummary, finalCounts, generation) {
  const outcome = { terminalStatus: OUTCOME.failed.terminal, errorSummary };
  if (finalCounts !== undefined && Object.keys(finalCounts).length > 0) {
    outcome.finalCounts = finalCounts;
  }
  return attemptComplete(intent, outcome, generation);
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
  } catch {
    return { kind: "server_status", ...unavailableServerStatus() };
  }
  const intentId = readString(
    Reflect.get(currentSnapshot, "intent"),
    "intentId",
  );
  if (!isSendableIntentId(intentId)) {
    return { kind: "server_status", state: "no_run" };
  }
  return {
    kind: "server_status",
    ...(await readServerRunStatus(intentId, generation)),
  };
}

// The server's record for ONE run id, read with the bearer of the session
// `generation`. Never throws: any fault (no session, replaced session,
// timeout, transport, malformed body) is "unavailable" — nothing is guessed.
async function readServerRunStatus(intentId, generation) {
  try {
    if (!isSendableIntentId(intentId)) return unavailableServerStatus();
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
        return unavailableServerStatus();
      }
      res = await attempt(refreshed);
    }
    return res.reply;
  } catch {
    return unavailableServerStatus();
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
// memory WITH the time it arrived, and the run its pending Start begins
// CONSUMES it (single use) within START_TTL_MS. A grant that merely exists —
// left over from a run whose revoke failed, from a Start whose registration
// this worker never saw, or older than the window — is not a Start: it is
// revoked so the next Start prompts again.
/** @type {Map<string, number>} */
const freshGrants = new Map();

// One Start exchange lives at most this long: a pending registration with no
// grant is revoked and reported after this window, and a grant that arrives
// for it later finds no registration and is revoked on arrival (S1-A1).
// Chrome's permission prompt has no deadline, so the popup registers BEFORE
// prompting and the worker starts only when both halves exist for one
// registration that is still live.
const START_TTL_MS = 60_000;

function hasFreshGrant(origin) {
  const at = freshGrants.get(origin);
  if (at === undefined) return false;
  if (Date.now() - at <= START_TTL_MS) return true;
  freshGrants.delete(origin);
  return false;
}

function takeFreshGrant(origin) {
  const at = freshGrants.get(origin);
  if (at === undefined) return false;
  freshGrants.delete(origin);
  return Date.now() - at <= START_TTL_MS;
}

// The popup's registered half of a Start exchange: recorded BEFORE the popup
// asks Chrome to prompt, so the run can begin whichever half arrives last and
// even if the prompt steals focus and closes the popup. Exactly one may be
// pending; a newer registration replaces an older one (the older Start failed).
/** @type {{ nonce: string | null, tabId: number | null, origin: string,
 *   url: string, kind: string, message: object, expiresAt: number,
 *   claimed: boolean,
 *   timer: ReturnType<typeof setTimeout> | null } | null} */
let pendingStart = null;

// R35-c7B-04: an MV3 worker is idle-terminated after ~30 s with no events,
// which is shorter than START_TTL_MS — a coach who reads Chrome's prompt for
// longer would lose the pending Start with the worker. While a Start is
// pending (and only then), a bounded heartbeat of extension API calls keeps
// the worker alive for the window; it stops the moment the Start is cleared.
const START_KEEPALIVE_MS = 20_000;
/** @type {ReturnType<typeof setInterval> | null} */
let startKeepalive = null;

function keepWorkerAlive() {
  if (startKeepalive !== null) return;
  const beat = () => {
    if (pendingStart === null) {
      stopKeepingWorkerAlive();
      return;
    }
    const platform = chrome.runtime.getPlatformInfo;
    if (typeof platform !== "function") return;
    // Keepalive is best-effort; the window's own deadline still bounds it.
    try {
      const result = platform.call(chrome.runtime);
      if (result && typeof result.catch === "function") {
        result.catch(() => logNetworkEvent("start_keepalive_failed"));
      }
    } catch {
      logNetworkEvent("start_keepalive_failed");
    }
  };
  const timer = setInterval(beat, START_KEEPALIVE_MS);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    timer.unref();
  }
  startKeepalive = timer;
}

function stopKeepingWorkerAlive() {
  if (startKeepalive !== null) {
    clearInterval(startKeepalive);
    startKeepalive = null;
  }
}

function clearPendingStart() {
  if (pendingStart !== null && pendingStart.timer !== null) {
    clearTimeout(pendingStart.timer);
  }
  pendingStart = null;
  stopKeepingWorkerAlive();
}

// Register the popup's half of a Start exchange. Bound to the initiating tab,
// its origin and the caller's nonce, and valid for START_TTL_MS: the run that
// later begins uses THESE values, never a tab id or url some other extension
// page supplies afterwards. A registration for ANOTHER origin supersedes a
// pending one (the superseded request stays outstanding for its own origin —
// its prompt may still be open); a registration for the SAME origin as a
// pending or outstanding request never gets here (admitStart refuses it).
function registerPendingStart(kind, message, origin) {
  if (pendingStart !== null) {
    const superseded = pendingStart;
    clearPendingStart();
    markStartOutstanding(superseded, "start_superseded");
    void expireStart(superseded.origin, "start_superseded");
  }
  const pending = {
    nonce: readString(message, "nonce"),
    tabId: readTabId(message),
    origin,
    url: typeof message.url === "string" ? message.url : "",
    kind,
    // The registering message itself, so the run is driven by what the
    // INITIATING page sent (including a caller-supplied token the legacy
    // entrypoint must refuse), never by a later message for the same origin.
    message,
    expiresAt: Date.now() + START_TTL_MS,
    claimed: false,
    timer: null,
  };
  const timer = setTimeout(() => {
    if (pendingStart === pending) {
      clearPendingStart();
      // A grant the coach accepts after this point belongs to an expired
      // Start: revoked on arrival with this reason (S1-A1).
      markStartOutstanding(pending, "start_expired");
      void expireStart(origin, "start_expired");
    }
  }, START_TTL_MS);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    timer.unref();
  }
  pending.timer = timer;
  pendingStart = pending;
  keepWorkerAlive();
  return pending;
}

// A grant Chrome ALREADY holds when a Start registers is not this Start's: the
// popup registers BEFORE it prompts, so a permission that exists at this
// moment is a leftover — a run whose revoke failed, a lost Start, or a grant
// made through Chrome's own UI. It is revoked and refused, so the next Start
// prompts afresh. Re-checked after the await: a grant that arrived meanwhile
// (the coach accepted) already began the run and is not touched.
async function screenHeldGrant(pending) {
  if ((await holdsGrant(pending.origin)) !== true) return;
  if (pendingStart !== pending || hasFreshGrant(pending.origin)) return;
  if (isActiveOrigin(pending.origin)) return;
  clearPendingStart();
  // The popup's request() usually answers true at once (held: no prompt) and
  // its start_granted resolves this; if the revoke below landed first, Chrome
  // DID prompt and the answer is unknown until it arrives (S1-A5-01).
  markStartOutstanding(pending, "start_not_authorized");
  await dropUnusedGrant(pending.origin, "start_refusal_revoke_failed");
  broadcastStatus({
    ...emptySnapshot(),
    lastError: `start_not_authorized: ${pending.origin}`,
  });
}

// The origin the run in flight is using. Its grant belongs to that run and is
// revoked by ITS settlement (settleRun), never by another Start's refusal —
// pulling it mid-run would abort the coach's live import.
function isActiveOrigin(origin) {
  return (
    startingOrigin === origin ||
    (activeRun !== null && activeRun.origin === origin)
  );
}

// The origin of the run being started, set SYNCHRONOUSLY when both halves of a
// Start exchange meet and cleared by settleRun. activeRun only exists a few
// awaits later (after the grant is re-checked), and an earlier refusal's
// asynchronous revoke must not land inside that window and kill the new run.
/** @type {string | null} */
let startingOrigin = null;

// Drop a grant no run owns: forget the fresh mark and remove the host
// permission if Chrome still holds it, VERIFIED. A removal that cannot be
// verified gone (remove rejected, or contains() could not answer) is not
// forgotten: the origin is recorded as grant debt, which closes the Start
// gate until a retry verifies the grant is gone (S1-A5-02) — exactly as a
// run's failed settlement does. Never throws.
async function dropUnusedGrant(origin, event) {
  freshGrants.delete(origin);
  if (isActiveOrigin(origin)) return;
  let gone = false;
  try {
    // An unreadable state is not "not held": attempt the revoke anyway.
    gone = (await holdsGrant(origin)) === false || (await revokeGrant(origin));
  } catch {
    gone = false;
  }
  if (gone) {
    grantDebts.delete(origin);
    return;
  }
  grantDebts.add(origin);
  logNetworkEvent(event);
}

// Start requests whose Chrome prompt may still be open and whose answer this
// worker has not learned, keyed by origin: the Start's tab closed or left the
// origin, the Start expired, was superseded by another origin's Start, or
// was refused while its popup may already have prompted. Chrome's prompt
// has no deadline and its onAdded event names only the ORIGIN, so the grant
// such a request asked for can arrive at ANY later time and is
// indistinguishable from a grant a newer Start on the same origin asked for
// (S1-A5-01). Therefore, while a request for an origin is outstanding:
//   - no new Start for that origin is registered (admitStart refuses it with
//     `start_prompt_outstanding`, so the popup does not open a second prompt
//     and there is never more than ONE request per origin whose answer can
//     still arrive on this worker);
//   - a grant that arrives for the origin is that request's answer: it is
//     revoked on arrival with the request's stop reason, and the request is
//     resolved.
// A request is also resolved by the popup's own report of Chrome's answer
// (start_granted / start_unavailable carrying the request's nonce). Nothing
// else resolves it: a declined or dismissed prompt whose popup is gone is
// never announced, so such a mark lives as long as this worker does.
/** @type {Map<string, { nonce: string | null, code: string }>} */
const outstandingStarts = new Map();

function markStartOutstanding(pending, code) {
  outstandingStarts.set(pending.origin, { nonce: pending.nonce, code });
}

// Resolve (and report) the outstanding request for an origin, if any.
function takeOutstandingStart(origin) {
  const entry = outstandingStarts.get(origin) ?? null;
  outstandingStarts.delete(origin);
  return entry;
}

// The popup reported Chrome's answer for a request that is no longer pending:
// its nonce identifies the request, so its outstanding mark is resolved.
function resolveOutstandingStart(nonce) {
  if (typeof nonce !== "string" || nonce === "") return false;
  for (const [origin, entry] of outstandingStarts) {
    if (entry.nonce === nonce) {
      outstandingStarts.delete(origin);
      return true;
    }
  }
  return false;
}

// An earlier request for this origin may still be answered: a new Start for
// it cannot be told apart from that answer, so it is not registered.
function hasOutstandingStart(origin) {
  return (
    outstandingStarts.has(origin) ||
    (pendingStart !== null && pendingStart.origin === origin)
  );
}

// Unbound host grants whose removal could not be VERIFIED (S1-A5-02). While
// any is owed, no Start is admitted; each refused Start retries the removal.
/** @type {Set<string>} */
const grantDebts = new Set();

function cleanupOwed() {
  return pendingCleanup !== null || grantDebts.size > 0;
}

// Retry every unverified unbound-grant removal. Never throws.
async function retryGrantDebts() {
  for (const origin of [...grantDebts]) {
    if (isActiveOrigin(origin)) continue;
    if (await revokeGrant(origin)) grantDebts.delete(origin);
  }
}

// Drop an expired or abandoned Start half and revoke whatever grant it may
// have left in Chrome, reporting a stable code. Never throws.
async function expireStart(origin, code) {
  await dropUnusedGrant(origin, "start_expiry_revoke_failed");
  broadcastStatus({ ...emptySnapshot(), lastError: `${code}: ${origin}` });
}

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

// The other half of the Start exchange. Either order is fine: the coach's
// accepted prompt may reach the worker before or after the popup's pending
// Start (a cold worker queues both), and the run begins as soon as BOTH exist
// for the SAME origin, bound to the same nonce, tab and origin. So the run
// proceeds even when Chrome's prompt closes the popup before it could send.
chrome.permissions.onAdded.addListener((permissions) => {
  for (const origin of grantedOrigins(permissions)) {
    if (isTgpOrigin(origin)) {
      // TGP's own origin authorizes nothing (the handler already said so):
      // drop the grant quietly, without overwriting that refusal.
      void dropUnusedGrant(origin, "start_expiry_revoke_failed");
      continue;
    }
    freshGrants.set(origin, Date.now());
    const pending = pendingStart;
    // Provenance (S1-A5-01): Chrome names only the origin, so this event is
    // attributable to a request only when exactly ONE request for the origin
    // can still be answered on this worker. An earlier request for the origin
    // whose answer never came (outstanding) is the ONLY such request —
    // admitStart registers no Start for an origin while one is outstanding —
    // so the event is its answer: revoked on arrival with its reason, never
    // claimed by whatever Start happens to be pending now.
    const earlier = takeOutstandingStart(origin);
    if (earlier !== null && pending !== null && pending.origin === origin) {
      // Unreachable through admitStart (it refuses this registration); if it
      // ever happens, the grant belongs to nobody provably: revoked, the
      // pending Start is refused, and the origin stays outstanding.
      clearPendingStart();
      markStartOutstanding(pending, "start_grant_ambiguous");
      void expireStart(origin, "start_grant_ambiguous");
      continue;
    }
    if (pending === null && (importInFlight || cleanupOwed())) {
      // No Start could be admitted right now, so no Start can claim this
      // grant: it is revoked at once rather than held for the window. The
      // running import's own origin is never touched.
      if (!isActiveOrigin(origin)) {
        void expireStart(
          origin,
          earlier?.code ??
            (cleanupOwed() ? "start_refused_cleanup" : "start_refused_busy"),
        );
      }
      continue;
    }
    if (pending === null) {
      // No pending Start on THIS worker is waiting for this grant, so nothing
      // can bind it to a nonce, a tab and a window (S1-A1). It is revoked on
      // arrival, never held: the Start that asked for it lost its tab
      // (R35-c7A-01; the outstanding mark carries that reason), or expired,
      // or lived in a worker that has since died, or the grant came from
      // Chrome's own UI. The popup registers BEFORE it prompts and waits for
      // the worker's reply, so a grant for a live Start always finds its
      // registration here; a grant that does not is not a Start.
      void expireStart(origin, earlier?.code ?? "start_not_registered");
      continue;
    }
    if (pending.origin !== origin) {
      // The grant names an origin this Start did not ask for: it is revoked
      // and nothing starts. The registration stays pending for its own origin.
      void expireStart(origin, earlier?.code ?? "start_grant_mismatch");
      continue;
    }
    if (Date.now() > pending.expiresAt) {
      clearPendingStart();
      void expireStart(origin, "start_expired");
      continue;
    }
    claimStart(pending);
  }
});

// Both halves of the Start exchange exist for one origin: consume the
// registration and begin the run. All checks and the single-flight set are
// SYNCHRONOUS, so no second claim can interleave. The fresh grant itself is
// consumed by authorizeSourceOrigin inside the handler.
function beginAuthorizedRun(pending) {
  clearPendingStart();
  if (cleanupOwed() || importInFlight) {
    // A run slipped in between registration and grant: this Start is refused,
    // and its grant must not outlive the refusal.
    void expireStart(
      pending.origin,
      cleanupOwed() ? "start_refused_cleanup" : "start_refused_busy",
    );
    return;
  }
  importInFlight = true;
  startingOrigin = pending.origin;
  // The run is driven by the REGISTERED Start, not by whatever a later message
  // claims: its tab id and url are the ones the initiating popup bound.
  const message = {
    ...pending.message,
    kind: pending.kind,
    url: pending.url,
    tabId: pending.tabId,
  };
  const handler =
    pending.kind === "start_ingest" ? handleStartIngest : handleStartImport;
  void handler(message).finally(settleRun);
}

// Admit (or refuse) a Start. Everything that decides admission is
// SYNCHRONOUS — the single pending slot and the single-flight flag are both
// taken before any await, so two Starts can never both proceed. Every refusal
// revokes whatever grant the origin may hold, so a refused Start leaves the
// extension holding nothing.
function admitStart(kind, message) {
  const url = typeof message.url === "string" ? message.url : "";
  const origin = tabOriginAllowlist(url)?.[0] ?? null;
  if (startupSweepFailed) {
    void retryStartupSweep();
    if (origin !== null) void refuseStart(origin, "cleanup_pending");
    return { ok: false, error: "cleanup_pending" };
  }
  if (cleanupOwed()) {
    void retryPendingCleanup();
    if (origin !== null) void refuseStart(origin, "cleanup_pending");
    return { ok: false, error: "cleanup_pending" };
  }
  // Shared single-flight (see importInFlight): reject a second concurrent run.
  // A claimed Start (grant matched, run about to begin) counts as running.
  if (importInFlight || (pendingStart !== null && pendingStart.claimed)) {
    if (origin !== null) void refuseStart(origin, "import_in_progress");
    return { ok: false, error: "import_in_progress" };
  }
  // A non-https or TGP origin authorizes nothing: the handler reports the
  // honest refusal itself (no origin is ever held, prompted for or granted).
  if (origin === null || isTgpOrigin(origin)) {
    importInFlight = true;
    const handler =
      kind === "start_ingest" ? handleStartIngest : handleStartImport;
    void handler(message).finally(settleRun);
    return { ok: true };
  }
  // S1-A5-01: an earlier request for THIS origin may still be answered (its
  // Chrome prompt is open, or was, and this worker never learned the answer).
  // Chrome's grant event names only the origin, so a second request for it
  // could never be told apart from that answer: nothing is registered, the
  // popup does not prompt, and the earlier request is left exactly as it is
  // (its grant, if it comes, is revoked as its own late answer).
  if (hasOutstandingStart(origin)) {
    logNetworkEvent("start_refused_outstanding");
    return { ok: false, error: "start_prompt_outstanding" };
  }
  // R35-c7A-01: a Start is bound to ONE verified tab. Without a tab id there
  // is nothing to bind the grant, the collector or the run's lifetime to, so
  // nothing is registered and the popup must not prompt.
  if (readTabId(message) === null) {
    void refuseStart(origin, "source_tab_required");
    return { ok: false, error: "source_tab_required" };
  }
  const pending = registerPendingStart(kind, message, origin);
  // The worker now waits: the coach's prompt is about to open. Either the
  // grant arrives (onAdded -> claimStart) or the popup reports that it will
  // not (start_granted / start_unavailable), and the window bounds both. A
  // grant that reached the worker BEFORE this registration was revoked on
  // arrival (no Start could bind it — S1-A1), and a grant Chrome ALREADY
  // holds is screened off the admission path so it cannot race it —
  // possession of a durable permission is never a Start.
  void screenHeldGrant(pending);
  return { ok: true };
}

// Both halves of one Start exchange exist. Begin the run, but never before the
// worker's startup sweep has verified that nothing a previous worker left
// behind survives (review A C02's admission race). The wait is bounded by the
// sweep itself; a sweep that cannot verify refuses the Start and revokes its
// grant rather than running with an unproven capability surface.
function claimStart(pending) {
  // Both halves met: from here on this Start owns its grant. A later message
  // for the same origin is refused as busy and must not revoke or replace it.
  pending.claimed = true;
  if (startupSwept) {
    beginAuthorizedRun(pending);
    return;
  }
  void retryStartupSweep().then((swept) => {
    if (pendingStart !== pending) return; // superseded, expired or cancelled
    if (!swept) {
      clearPendingStart();
      pendingCleanup = pendingCleanup ?? { origin: null };
      void expireStart(pending.origin, "cleanup_pending");
      return;
    }
    beginAuthorizedRun(pending);
  });
}

// The popup could not obtain the grant (the coach declined Chrome's prompt, or
// the prompt was unavailable): the registered Start ends now with an honest
// code rather than waiting out its window. Only the registrant's own nonce may
// cancel it.
function cancelPendingStart(message) {
  const pending = pendingStart;
  const nonce = readString(message, "nonce");
  if (pending === null || pending.nonce !== nonce) {
    // The popup of a request that is no longer pending (its tab closed, it
    // expired, ...) reports Chrome's answer: that request is resolved, so a
    // new Start for its origin may register again (S1-A5-01).
    if (resolveOutstandingStart(nonce)) return { ok: true };
    return { ok: false, error: "no_pending_start" };
  }
  // R35-c7B-02: a claimed Start (its grant already matched; the run is about
  // to begin) belongs to that run. A late popup message cannot cancel it or
  // revoke its grant.
  if (pending.claimed) {
    return { ok: false, error: "no_pending_start" };
  }
  clearPendingStart();
  void expireStart(pending.origin, "origin_not_granted");
  return { ok: true };
}

// The popup reports that Chrome answered its request with `true`. When the
// coach actually accepted a prompt, permissions.onAdded already began the run
// and there is nothing pending. `true` with NOTHING announced means Chrome
// held the origin BEFORE this Start: possession of a durable permission is not
// a Start, so it is revoked and refused and the next Start prompts afresh.
function confirmGrantedStart(message) {
  const pending = pendingStart;
  const nonce = readString(message, "nonce");
  if (pending === null || pending.nonce !== nonce || pending.claimed) {
    // Chrome's answer for a request no longer pending: resolved (S1-A5-01).
    // Its grant, if one was announced, was already revoked on arrival.
    resolveOutstandingStart(nonce);
    return { ok: true }; // the run already began (or is beginning) on the grant event
  }
  clearPendingStart();
  void expireStart(pending.origin, "start_not_authorized");
  return { ok: false, error: "start_not_authorized" };
}

// A refused Start must leave nothing behind: drop any fresh grant for the
// origin and revoke the host permission if Chrome holds it. The refusal code
// itself already travelled back to the caller as the message reply.
async function refuseStart(origin, code) {
  const pending = pendingStart;
  if (pending !== null && pending.origin === origin) {
    // A claimed Start's grant belongs to the run that is beginning.
    if (pending.claimed) return;
    clearPendingStart();
    // Its popup may have prompted already; the answer is still to come.
    markStartOutstanding(pending, code);
  }
  if (!isActiveOrigin(origin)) {
    await dropUnusedGrant(origin, "start_refusal_revoke_failed");
  }
  logNetworkEvent(
    code === "import_in_progress"
      ? "start_refused_busy"
      : code === "source_tab_required"
        ? "start_refused_no_tab"
        : "start_refused_cleanup",
  );
}

// The run currently holding the authorization, so a revocation or the loss of
// its Start tab can reach it. Opened as soon as an origin is authorized
// (before any tab or network work), closed by settleRun. `ended` carries the
// honest stop reason once the run's capability ended from outside
// (origin_revoked, source_tab_closed, source_tab_navigated); null while live.
/** @type {{ origin: string, tabId: number | null, generation: number,
 *   controller: AbortController, ended: string | null } | null} */
let activeRun = null;

function openRun(origin, tabId, generation) {
  const run = {
    origin,
    tabId,
    generation,
    controller: new AbortController(),
    ended: null,
  };
  activeRun = run;
  return run;
}

function revokedDetail(origin) {
  return `origin_revoked: ${origin}`;
}
function tabClosedDetail(origin) {
  return `source_tab_closed: ${origin}`;
}
function tabNavigatedDetail(origin) {
  return `source_tab_navigated: ${origin}`;
}

// A source run's capability must still hold at EVERY settlement boundary, not
// merely when the reader was started. The reader can resolve normally while
// the coach's revocation (or the Start tab's closure) is in flight, so this
// is re-checked synchronously before the terminal POST and again before the
// terminal broadcast. Returns the honest stop reason, or null while the run
// still holds its capability. A TGP session clear or replacement mid-run also
// drops the authorized origin, but that is a SESSION change, not a source
// permission loss: it is reported as such (R35-c7B-05), never as
// `origin_revoked`.
function runEnded(run) {
  if (run.ended !== null) return run.ended;
  if (getSessionGeneration() !== run.generation) return SESSION_REPLACED_DETAIL;
  if (getAuthorizedOrigin() !== run.origin) return revokedDetail(run.origin);
  return null;
}

// End the active run from outside, NOW: the crawl is aborted, the
// authorization is dropped so no capture session stays live, the grant is
// revoked (settleRun revokes and VERIFIES again), and the run reports
// `detail`. Idempotent: the first reason wins.
function endRun(run, detail) {
  if (run.ended !== null) return;
  run.ended = detail;
  freshGrants.delete(run.origin);
  clearAuthorizedOrigin();
  run.controller.abort();
  void retireCaptureSessions();
  void revokeGrant(run.origin);
}

// Settle a run whose capability ended while it was completing, BEFORE any
// terminal was sent: the TGP session is intact, so the intent is settled
// FAILED with the honest reason and the coach is never shown a success for
// work the grant no longer covers.
async function settleEnded(run, detail, intent, tally, generation, reporter) {
  run.ended = detail;
  if (reporter !== undefined) {
    // Best-effort: a progress flush failing must not hide the stop.
    await reporter.flush(null, detail).catch(logSettlementFailure);
  }
  const acked = await settleFailed(
    intent,
    detail,
    Object.fromEntries(tally),
    generation,
  );
  await reportTerminal(run, intent, generation, OUTCOME.failed, detail, acked);
}

// The server's status word -> the popup state that shows it. The backend owns
// lifecycle truth: once a terminal POST has been ATTEMPTED, whatever the
// extension observes locally (grant revoked, tab closed, a reply that never
// came) can no longer decide the outcome, because the backend may already
// have committed it.
const SERVER_TERMINAL_STATE = {
  success: "ingest_succeeded",
  complete: "ingest_succeeded",
  partial: "ingest_partial",
  failed: "ingest_failed",
  blocked: "ingest_failed",
  cancelled: "ingest_failed",
  timed_out: "ingest_failed",
};

// The popup state for "a terminal was attempted and the server has not
// confirmed how the run ended": not a failure, not a success — the coach is
// told to check TGP's record. Never inferred into anything else locally.
const UNCONFIRMED_STATE = "ingest_unconfirmed";

// The one place a run's terminal reaches the popup once a /complete has been
// ATTEMPTED (S1-A2 generalises R35-c7A-02). `outcome` is the OUTCOME entry
// the extension POSTed, `detail` its local reason line (null when clean) and
// `acked` is `true` when the backend acknowledged that POST, else the Error
// the attempt ended with.
//   - acknowledged, capability intact: the acknowledged outcome IS the
//     server's answer and is shown (with the completion notification when
//     `notify`).
//   - anything else (reply lost or refused, or the run's capability ended
//     meanwhile): the server's status is read and shown; nothing is inferred.
//   - a session replaced during the POST is a SESSION change: the current
//     session is intact, the old intent is left unsettled and no status is
//     read under a session this run does not own.
async function reportTerminal(
  run,
  intent,
  generation,
  outcome,
  detail,
  acked,
  notify = false,
) {
  if (isTgpSessionReplaced(acked)) {
    broadcastStatus({
      ...currentSnapshot,
      intent: { ...intent, status: "ingest_failed" },
      lastError: SESSION_REPLACED_DETAIL,
    });
    return;
  }
  if (acked === true && runEnded(run) === null) {
    broadcastStatus({
      ...currentSnapshot,
      intent: { ...intent, status: outcome.state },
      lastError: detail,
    });
    if (notify) notifyOutcome(intent.platform, outcomeWord(outcome));
    return;
  }
  await showAuthoritativeTerminal(
    run,
    intent,
    generation,
    acked === true
      ? { state: outcome.state, detail, terminal: outcome.terminal }
      : null,
    detail,
    acked,
  );
}

// The engine word an OUTCOME entry stands for (its notification copy).
function outcomeWord(outcome) {
  for (const [word, entry] of Object.entries(OUTCOME)) {
    if (entry === outcome) return word;
  }
  return "failed";
}

// The PII-free category of a /complete attempt that was not acknowledged:
// `complete_timeout`, `complete <http status>` or `complete_network_error`.
// Never a transport message (it could carry a URL).
function completeFailureCategory(failure) {
  const message = failure instanceof Error ? failure.message : "";
  return message === "complete_timeout" || /^complete \d{3}$/.test(message)
    ? message
    : "complete_network_error";
}

// R35-c7A-02 / S1-A2: a terminal POST has been attempted, and either the
// run's capability ended meanwhile or the backend's reply never came. The
// extension never asserts a local terminal that can contradict the backend:
// it reads the server's authoritative run status and shows THAT. If the
// server has a settled terminal, that is the result. If it does not (or
// cannot be read) but the backend ACKNOWLEDGED our terminal, the acknowledged
// outcome is the server's own answer and is shown. Otherwise nothing is
// known: the run is shown as UNCONFIRMED (never `failed`), with what the
// server did say (`serverStatus`: running / not_yet_known / unavailable), and
// no second terminal is ever sent over a possibly committed one.
async function showAuthoritativeTerminal(
  run,
  intent,
  generation,
  acked,
  detail,
  failure,
) {
  const ended = runEnded(run);
  const reason = ended ?? detail ?? completeFailureCategory(failure);
  const server = await readServerRunStatus(intent.intentId, generation);
  if (server.state === "known" && server.settled === true) {
    const status = String(server.status);
    const state = SERVER_TERMINAL_STATE[status] ?? "ingest_failed";
    broadcastStatus({
      ...currentSnapshot,
      intent: { ...intent, status: state },
      lastError: state === "ingest_failed" ? reason : null,
      serverTerminal: status,
    });
    return;
  }
  if (acked !== null) {
    broadcastStatus({
      ...currentSnapshot,
      intent: { ...intent, status: acked.state },
      lastError: acked.detail,
      serverTerminal: acked.terminal,
    });
    return;
  }
  broadcastStatus({
    ...currentSnapshot,
    intent: { ...intent, status: UNCONFIRMED_STATE },
    lastError: `complete_unconfirmed: ${reason}`,
    serverStatus:
      server.state === "known" ? String(server.status) : server.state,
    completeAttempt: completeFailureCategory(failure),
  });
}

// The coach withdrew the run's host grant (chrome://extensions, or another
// extension page) while the run was in flight: the run stops NOW, not at its
// next admission check, and reports `origin_revoked`. The worker's own
// revocation at settlement finds the grant gone and verifies that.
chrome.permissions.onRemoved.addListener((permissions) => {
  const run = activeRun;
  if (run === null || run.ended !== null) return;
  if (!grantedOrigins(permissions).includes(run.origin)) return;
  endRun(run, revokedDetail(run.origin));
});

// R35-c7A-01: the one-tab Start capability never outlives its tab. Closing the
// Start tab ends the pending Start (its grant is revoked, nothing starts) or
// the run in flight (aborted, authorization dropped, grant revoked, settled
// honestly as `source_tab_closed`). Cookie-authenticated replay from the
// worker therefore cannot continue once the coach's live tab is gone.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (typeof tabId !== "number") return;
  const pending = pendingStart;
  if (pending !== null && pending.tabId === tabId) {
    clearPendingStart();
    markStartOutstanding(pending, "source_tab_closed");
    void expireStart(pending.origin, "source_tab_closed");
  }
  const run = activeRun;
  if (run !== null && run.ended === null && run.tabId === tabId) {
    endRun(run, tabClosedDetail(run.origin));
  }
});

// The Start tab left its origin (main-frame navigation): the coach is no
// longer looking at the site the Start authorized, so the pending Start or
// the run ends as `source_tab_navigated`. Same-origin navigations keep it.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof tabId !== "number") return;
  const url = readString(changeInfo, "url");
  if (url === null) return;
  const origin = tabOriginAllowlist(url)?.[0] ?? null;
  const pending = pendingStart;
  if (
    pending !== null &&
    pending.tabId === tabId &&
    origin !== pending.origin
  ) {
    clearPendingStart();
    markStartOutstanding(pending, "source_tab_navigated");
    void expireStart(pending.origin, "source_tab_navigated");
  }
  const run = activeRun;
  if (
    run !== null &&
    run.ended === null &&
    run.tabId === tabId &&
    origin !== run.origin
  ) {
    endRun(run, tabNavigatedDetail(run.origin));
  }
});

function grantPattern(origin) {
  return `${origin}/*`;
}

// Tri-state (R35-c7A-03): true = Chrome holds the grant, false = Chrome
// verified it does not, null = Chrome could not answer. A failed read is
// never mistaken for "not held".
async function holdsGrant(origin) {
  try {
    return (
      (await chrome.permissions.contains({
        origins: [grantPattern(origin)],
      })) === true
    );
  } catch {
    return null;
  }
}

// Revoke an origin's host grant and confirm Chrome no longer holds it. Only a
// VERIFIED absence counts: a removal that throws, or a verification read that
// fails, reports false so the caller keeps the cleanup pending.
async function revokeGrant(origin) {
  try {
    await chrome.permissions.remove({ origins: [grantPattern(origin)] });
  } catch {
    return false;
  }
  return (await holdsGrant(origin)) === false;
}

// The tab's https origin becomes the run's single authorized origin ONLY if it
// is not a TGP origin, Chrome holds the host permission, that permission is a
// fresh Start grant (see freshGrants), AND the Start's own tab is still live
// on that origin. The worker never trusts the popup's claim; it asks Chrome,
// and it consumes the grant. A grant whose tab is gone or has left the origin
// is revoked here and never becomes the authorized origin (S1-A1) — the tab
// events (tabs.onRemoved / onUpdated) usually end such a Start first, but the
// binding is verified against Chrome at the moment of authorization too.
async function authorizeSourceOrigin(url, tabId) {
  const origin = tabOriginAllowlist(url)?.[0] ?? null;
  if (origin === null) {
    return { error: `unsafe import origin: ${describedOrigin(url)}` };
  }
  if (isTgpOrigin(origin)) {
    return { error: `origin_is_tgp: ${origin}` };
  }
  if ((await holdsGrant(origin)) !== true) {
    // Not held, or Chrome could not say: neither authorizes anything.
    freshGrants.delete(origin);
    return { error: `origin_not_granted: ${origin}` };
  }
  if (!takeFreshGrant(origin)) {
    // Possession of a durable permission is not a Start. Drop it so the coach
    // is prompted afresh next time.
    await revokeGrant(origin);
    return { error: `start_not_authorized: ${origin}` };
  }
  if (typeof tabId !== "number") {
    // admitStart refuses such a Start before anything is registered; a run
    // reaching this point without a tab still authorizes nothing.
    await revokeGrant(origin);
    return { error: `source_tab_required: ${origin}` };
  }
  const tab = await liveTab(tabId);
  if (tab.gone || tab.origin !== origin) {
    await revokeGrant(origin);
    return {
      error: tab.gone ? tabClosedDetail(origin) : tabNavigatedDetail(origin),
    };
  }
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
  const authorized = await authorizeSourceOrigin(url, readTabId(message));
  if (authorized.error !== undefined) {
    broadcastStatus({ ...emptySnapshot(), lastError: authorized.error });
    return;
  }
  const run = openRun(authorized.origin, readTabId(message), generation);
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
  if (run.ended !== null) {
    broadcastStatus({ ...emptySnapshot(), lastError: run.ended });
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
    // FENCE: the reader returned, but the grant (or the Start tab) may have
    // gone while it was resolving or while the ACKed batches were flushing. A
    // run that ended is never ACKed as complete/empty.
    const endedBefore = runEnded(run);
    if (endedBefore !== null) {
      settlementSent = true;
      await settleEnded(run, endedBefore, intent, tally, generation);
      return;
    }
    const outcome = OUTCOME[result.status];
    const detail = terminalDetail(result);
    settlementSent = true;
    const acked = await attemptComplete(
      intent,
      {
        terminalStatus: outcome.terminal,
        finalCounts: result.counts,
        errorSummary: detail ?? undefined,
      },
      generation,
    );
    // FENCE (R35-c7A-02 / S1-A2): the terminal POST has been attempted, so
    // the backend may own the outcome already. Neither a capability that
    // ended meanwhile nor a reply that never came decides anything locally:
    // the acknowledged outcome, or else the server's status, is shown.
    await reportTerminal(run, intent, generation, outcome, detail, acked, true);
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
    // A grant or tab lost mid-run is the honest stop, not the abort it caused.
    const detail =
      run.ended ?? (err instanceof Error ? err.message : "import failed");
    // Same unsettled-intent defect as the replay path; no progress-channel
    // fallback here, so carry the already-ACKed tally into the settlement.
    // A settlement already attempted above is never repeated: the server is
    // asked instead, and nothing is inferred.
    if (settlementSent) {
      await showAuthoritativeTerminal(
        run,
        intent,
        generation,
        null,
        detail,
        err,
      );
      return;
    }
    const acked = await settleFailed(
      intent,
      detail,
      Object.fromEntries(tally),
      generation,
    );
    await reportTerminal(
      run,
      intent,
      generation,
      OUTCOME.failed,
      detail,
      acked,
    );
  }
}

// ---- autonomous replay run (start_import) -----------------------------------
// Single-flight: a boolean set SYNCHRONOUSLY in the router before the async
// handler runs (so a pre-await race cannot pass) and SHARED across BOTH ingest
// entrypoints (start_import + legacy start_ingest). Cleared when the run settles.
let importInFlight = false;

// Cleanup the last run still owes. While set (or while any unbound grant's
// removal is unverified — grantDebts, see cleanupOwed), no run is admitted:
// the next Start retries the cleanup and is refused until every step is
// verified.
/** @type {{ origin: string | null } | null} */
let pendingCleanup = null;

// Whether this worker has finished removing what a previous worker (or a
// previous browser session) left behind. Chrome keeps optional host grants
// across browser restarts, so a worker that died mid-run leaves the extension
// holding a cookie-bearing host capability outside any run. NO run begins
// until the sweep has verified every unclaimed optional grant gone: a grant
// must never exist outside the Start that asked for it, and the coach must
// never be refused Start because a previous worker left one behind.
let startupSwept = false;
// A sweep that ran and could NOT verify: the Start gate is closed (refused
// `cleanup_pending`) and every refused Start retries it, exactly like a failed
// settlement. Distinct from "not finished yet", which merely waits.
let startupSweepFailed = false;

function originOfPattern(pattern) {
  return typeof pattern === "string" ? pattern.replace(/\/\*$/, "") : "";
}

// An origin the CURRENT Start exchange or the run in flight owns. The startup
// sweep must not pull the grant out from under a live exchange: on a cold
// worker the coach's accepted prompt and the worker's first sweep race, and
// revoking there would be destructive rather than fail-closed.
function claimedOrigin(origin) {
  return (
    hasFreshGrant(origin) ||
    (pendingStart !== null && pendingStart.origin === origin) ||
    isActiveOrigin(origin)
  );
}

// Optional host origins Chrome holds that no live Start exchange claims. The
// required TGP API host is declared in the manifest, is not optional, and is
// deliberately kept.
async function unclaimedHeldOrigins() {
  const all = await chrome.permissions.getAll();
  const patterns =
    isRecord(all) && Array.isArray(all.origins) ? all.origins : [];
  return patterns.filter((pattern) => {
    if (typeof pattern !== "string") return false;
    const origin = originOfPattern(pattern);
    return !isTgpOrigin(origin) && !claimedOrigin(origin);
  });
}

// Remove every unclaimed optional host grant and VERIFY it is gone. A failure
// (or a permissions API fault) is reported as false so the caller fails closed.
async function sweepStartupGrants() {
  let held;
  try {
    held = await unclaimedHeldOrigins();
  } catch {
    return false;
  }
  for (const pattern of held) {
    // Re-checked per origin: a Start exchange can begin while the sweep is
    // awaiting Chrome, and the coach's just-granted origin must survive.
    if (claimedOrigin(originOfPattern(pattern))) continue;
    try {
      await chrome.permissions.remove({ origins: [pattern] });
    } catch {
      logNetworkEvent("startup_grant_revoke_failed");
    }
  }
  try {
    return (await unclaimedHeldOrigins()).length === 0;
  } catch {
    return false;
  }
}

// The whole startup sweep: leftover host grants AND any collector registration
// an earlier build left, both verified gone before any run begins.
async function runStartupSweep() {
  const grantsGone = await sweepStartupGrants();
  const collectorGone = await unregisterSourceCollector();
  startupSwept = grantsGone && collectorGone;
  startupSweepFailed = !startupSwept;
  if (startupSweepFailed) {
    logNetworkEvent("startup_sweep_pending");
  }
  return startupSwept;
}

// A refused Start retries the sweep, so a transient Chrome fault does not
// strand the coach. Single-flight so concurrent Starts do not pile up.
/** @type {Promise<boolean> | null} */
let startupSweepInFlight = null;
function retryStartupSweep() {
  if (startupSwept) return Promise.resolve(true);
  if (startupSweepInFlight === null) {
    startupSweepInFlight = runStartupSweep().finally(() => {
      startupSweepInFlight = null;
    });
  }
  return startupSweepInFlight;
}

// A run's authorization ends with the run, in this order: every capture
// debugger is retired (no event or stop can outlive the run), the authorized
// origin is dropped, the collector registration is removed and VERIFIED gone,
// the origin's host grant is revoked and VERIFIED gone, and only then is the
// single-flight guard released. Any failed step keeps the guard closed
// (pendingCleanup) — cleanup is never assumed. Never throws.
async function settleRun() {
  // A revoked run already dropped its origin; its grant is still cleaned up.
  const origin = activeRun?.origin ?? getAuthorizedOrigin() ?? startingOrigin;
  activeRun = null;
  startingOrigin = null;
  await retireCaptureSessions();
  clearAuthorizedOrigin();
  if (origin !== null) freshGrants.delete(origin);
  const clean = await cleanUp(origin);
  pendingCleanup = clean ? null : { origin };
  if (clean && origin !== null) grantDebts.delete(origin);
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

// Retry the cleanup a previous run left pending, and every unbound-grant
// removal that could not be verified (S1-A5-02); admits new runs once ALL of
// it is verified. Never throws.
async function retryPendingCleanup() {
  await retryGrantDebts();
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

// The classic collector (content/main.js) is not declared in the manifest and
// is never REGISTERED: it is injected once, into the one tab the coach started
// from, with the host permission granted on Start, and the token is read
// straight afterwards. A dynamic registration would buy nothing (nothing
// consumes a page announcement) while injecting into every same-origin load
// for the life of the run and outliving a worker that died mid-run — so there
// is no registration to leak.
const SOURCE_COLLECTOR_ID = "tgp-source-collector";
const SOURCE_COLLECTOR_SCRIPT = "content/main.js";

// Inject the collector into the tab's main-frame document and return that
// document's id (Chrome 106+ InjectionResult.documentId), or null when Chrome
// named none — the caller then has no document to bind the reply to.
async function injectSourceCollector(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: [SOURCE_COLLECTOR_SCRIPT],
  });
  const main = Array.isArray(results)
    ? results.find((r) => isRecord(r) && r.frameId === 0)
    : undefined;
  const documentId = readString(main, "documentId");
  return documentId !== null && documentId.length > 0 ? documentId : null;
}

// Remove a collector registration an EARLIER build of this extension may have
// left behind (Chrome keeps a persistAcrossSessions:false registration until
// the browser restarts) and VERIFY it is gone. Nothing registers one any more;
// this is the startup ratchet that proves none survives. A missing
// registration is not a fault; a Chrome API failure is reported as `false` so
// the caller fails closed (the Start gate stays closed).
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

// The tab's live state as Chrome reports it: `gone` when Chrome no longer
// knows the tab (closed, or the read failed — neither is a live tab), else
// its https document origin (null when the document is not https).
async function liveTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return {
      gone: false,
      origin: tabOriginAllowlist(readString(tab, "url"))?.[0] ?? null,
    };
  } catch {
    return { gone: true, origin: null };
  }
}

// The tab's live document origin, or null when the tab is gone / not https.
async function liveTabOrigin(tabId) {
  return (await liveTab(tabId)).origin;
}

// Obtain the SOURCE bearer from the coach's own tab WITHOUT exposing it to
// popup/storage/logs/payload. The token is bound to ONE document on the
// authorized origin: the tab is checked before the collector is injected,
// again after every await (a navigation during injection or collection fails
// the run), and the collector's reply must name the document origin it read
// from. Returns { token } ("" when the page holds none) or { error }.
async function collectSourceToken(tabId, origin) {
  if (typeof tabId !== "number") {
    // R35-c7A-01: no verified live tab, no run — never an "empty token" that
    // lets cookie-authenticated replay proceed without a tab at all.
    return { error: `source_tab_required: ${origin}` };
  }
  const navigated = tabNavigatedDetail(origin);
  if ((await liveTabOrigin(tabId)) !== origin) {
    return { error: navigated };
  }
  let reply;
  try {
    // R35-c7A-04: the collector is injected into ONE document, and the
    // request is addressed to THAT document (Chrome's documentId), so a reply
    // from a same-origin replacement document — a navigation or account
    // switch racing the collection — is never accepted for the Start
    // document. An injection that names no document binds nothing and fails.
    const documentId = await injectSourceCollector(tabId);
    if (documentId === null) {
      return { error: navigated };
    }
    if ((await liveTabOrigin(tabId)) !== origin) {
      return { error: navigated };
    }
    reply = await chrome.tabs.sendMessage(
      tabId,
      { kind: "collect_source_token" },
      { documentId },
    );
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
  const authorized = await authorizeSourceOrigin(url, readTabId(message));
  if (authorized.error !== undefined) {
    broadcastStatus({ ...emptySnapshot(), lastError: authorized.error });
    return;
  }
  const run = openRun(authorized.origin, readTabId(message), generation);
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
  const collected = await collectSourceToken(
    readTabId(message),
    authorized.origin,
  );
  if (run.ended !== null) {
    broadcastStatus({ ...emptySnapshot(), lastError: run.ended });
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
    // FENCE: the replay returned, but the coach's grant or Start tab may have
    // gone while it was resolving or while its last batches were being ACKed.
    // Whatever the engine reported — cancelled, complete, empty or partial —
    // a run that ended settles and is shown with its honest stop reason,
    // never as a success.
    const endedBefore = runEnded(run);
    if (endedBefore !== null) {
      settlementSent = true;
      await settleEnded(run, endedBefore, intent, tally, generation, reporter);
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
    // Every terminal requires the backend's acknowledgement — an engine
    // `failed` as much as a success. FENCE (R35-c7A-02 / S1-A2): once the
    // POST has been attempted the backend may own the outcome already, so
    // neither a capability that ended meanwhile (grant revoked, tab closed)
    // nor a reply that never came is turned into a local terminal: the
    // acknowledged outcome, or else the server's status, is shown.
    const acked = await attemptComplete(intent, settlement, generation);
    await reportTerminal(
      run,
      intent,
      generation,
      outcome,
      detail,
      acked,
      result.status !== "failed",
    );
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
    // A grant or tab lost mid-run is the honest stop, not the abort it caused.
    const detail =
      run.ended ??
      (isAuthLost(err)
        ? "source sign-in required — open your source platform and try again"
        : err instanceof Error
          ? err.message
          : "import failed");
    // TGP session is still good, so the intent must be settled first. A
    // settlement already attempted above is never repeated: the server is
    // asked instead, and nothing is inferred.
    if (settlementSent) {
      await showAuthoritativeTerminal(
        run,
        intent,
        generation,
        null,
        detail,
        err,
      );
      return;
    }
    await reporter.flush(null, detail);
    const acked = await settleFailed(
      intent,
      detail,
      Object.fromEntries(tally),
      generation,
    );
    await reportTerminal(
      run,
      intent,
      generation,
      OUTCOME.failed,
      detail,
      acked,
    );
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

// Nothing a previous worker (or a previous browser session) left behind may
// survive into this one: Chrome keeps optional host grants across browser
// restarts and keeps a persistAcrossSessions:false registration until the
// browser restarts, so a worker that died mid-run would otherwise leave the
// extension holding a cookie-bearing host capability outside any run. No run
// can be in flight when this module evaluates, so both are removed here and
// VERIFIED gone. Until that is verified, every Start is refused
// (cleanup_pending) and retries the sweep — exactly like a failed settlement.
// Registered as the in-flight sweep so a Start claimed while it runs waits on
// it instead of starting a second one.
void retryStartupSweep();

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
  if (isStartIngest(message) || isStartImport(message)) {
    // A crawl reuses the coach's SOURCE session, so it may only be triggered by
    // one of THIS extension's own pages — an id match alone is not enough (a
    // compromised content script shares the id). Gate on the trusted-page
    // shape. The legacy start_ingest entrypoint is held to the same rule.
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({ ok: false, error: "untrusted_sender" });
      return false;
    }
    sendResponse(
      admitStart(
        isStartIngest(message) ? "start_ingest" : "start_import",
        message,
      ),
    );
    return false;
  }
  if (isStartUnavailable(message)) {
    // The popup's Start could not obtain the grant: end its pending Start now.
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({ ok: false, error: "untrusted_sender" });
      return false;
    }
    sendResponse(cancelPendingStart(message));
    return false;
  }
  if (isStartGranted(message)) {
    // Chrome answered the popup's request with `true`. Only the grant EVENT
    // authorizes a run; this message can only ever refuse a pre-held grant.
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({ ok: false, error: "untrusted_sender" });
      return false;
    }
    sendResponse(confirmGrantedStart(message));
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
