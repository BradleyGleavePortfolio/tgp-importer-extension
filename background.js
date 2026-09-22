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
import { TGP_API_ORIGIN, makeScoutIngestBody } from "./shared/protocol.js";
import { readIngestAcknowledgement } from "./shared/ingest-ack.js";
import {
  establishSession,
  hasActiveSession,
  getAccessToken,
  refreshAccessToken,
  clearTokensIfSession,
  getSessionGeneration,
} from "./shared/session.js";
import { detectPlatform } from "./extractors/detect.js";
import { TrueCoachExtractor } from "./extractors/truecoach.js";
import {
  runReplay,
  AuthLostError,
  isAuthLost,
} from "./shared/replay/engine.js";
import {
  resolveBlueprint,
  isUnknownPlatform,
} from "./shared/replay/resolve.js";
import {
  fetchWithTimeout,
  isTimeout,
  parseRetryAfterMs,
  readHeader,
} from "./shared/net.js";
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

function reportPreflightFailure(failure) {
  if (failure.replaced) {
    // The CURRENT session is intact: no auth_required, nothing cleared.
    broadcastStatus({ ...emptySnapshot(), lastError: SESSION_REPLACED_DETAIL });
    return;
  }
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

function extractorFor(platform, deps) {
  if (platform === "truecoach") {
    return new TrueCoachExtractor(deps);
  }
  // v0.3: other platforms currently return null from detectPlatform, so this
  // branch is unreachable until the next platform's extractor lands.
  return null;
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
  const platform = detectPlatform(url);
  if (platform === null) {
    broadcastStatus({
      ...emptySnapshot(),
      lastError: `unsupported site: ${describedOrigin(url)}`,
    });
    return;
  }
  // Verify the OWNING session has (or can mint) a TGP access token before
  // starting.
  const preflight = await preflightOwnedSession(generation);
  if (preflight !== null) {
    reportPreflightFailure(preflight);
    return;
  }

  const controller = new AbortController();
  const intent = {
    intentId: `ext-${Date.now()}`,
    platform,
    status: "ingest_started",
  };
  broadcastStatus({ ...emptySnapshot(), intent, progress: [] });

  // The extractor keeps no tally of its own, so the sender keeps one for it.
  const tally = new Map();
  const staging = new Map();
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
  const wrappedBroadcast = (snap) =>
    broadcastStatus({ ...currentSnapshot, ...snap, intent });

  // The source-platform bearer token (e.g. TrueCoach) is captured in-tab and
  // passed on the start message; the extractor reuses the coach's session.
  const sourceToken =
    typeof message.sourceToken === "string" ? message.sourceToken : "";

  const extractor = extractorFor(platform, {
    sendEntities,
    broadcastStatus: wrappedBroadcast,
    now: () => new Date(),
  });
  if (extractor === null) {
    broadcastStatus({
      ...emptySnapshot(),
      lastError: `no extractor for ${platform}`,
    });
    return;
  }

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
    const detail = err instanceof Error ? err.message : "import failed";
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
  } catch {
    return "";
  }
  const origin = tabOriginAllowlist(readString(tab, "url"))?.[0] ?? null;
  if (origin === null || !allowedOrigins.includes(origin)) {
    return ""; // the tab is not (or no longer) the confirmed source origin
  }
  let reply;
  try {
    reply = await chrome.tabs.sendMessage(tabId, {
      kind: "collect_source_token",
    });
  } catch {
    return ""; // no content script / port closed — proceed token-less (fails closed downstream)
  }
  return isRecord(reply) && reply.ok === true && typeof reply.token === "string"
    ? reply.token
    : "";
}

async function handleStartImport(message) {
  // The session this accepted Start belongs to, bound SYNCHRONOUSLY at
  // admission (the router calls this before yielding), before any await. Any
  // later establish/clear makes the run obsolete (see ownedAccessToken /
  // sessionLossError); the run never adopts a session that appears later.
  const generation = getSessionGeneration();
  const url = typeof message.url === "string" ? message.url : "";
  const platform = detectPlatform(url);
  if (platform === null) {
    broadcastStatus({
      ...emptySnapshot(),
      lastError: `unsupported site: ${describedOrigin(url)}`,
    });
    return;
  }
  const allowedOrigins = tabOriginAllowlist(url);
  if (allowedOrigins === null) {
    broadcastStatus({
      ...emptySnapshot(),
      lastError: `unsafe import origin: ${describedOrigin(url)}`,
    });
    return;
  }
  let blueprint;
  try {
    blueprint = resolveBlueprint(platform);
  } catch (err) {
    const detail = isUnknownPlatform(err)
      ? `no blueprint for ${platform}`
      : "blueprint resolve failed";
    broadcastStatus({ ...emptySnapshot(), lastError: detail });
    return;
  }
  // A TGP access token of the OWNING session is required for ingest before we
  // start crawling.
  const preflight = await preflightOwnedSession(generation);
  if (preflight !== null) {
    reportPreflightFailure(preflight);
    return;
  }

  const controller = new AbortController();
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
  // Real source bearer from the coach's own tab; absent -> "" -> fails closed.
  const sourceToken = await collectSourceToken(message.tabId, allowedOrigins);
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
    const detail = isAuthLost(err)
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
    // Shared single-flight (see importInFlight): reject a second concurrent run.
    if (importInFlight) {
      sendResponse({ ok: false, error: "import_in_progress" });
      return false;
    }
    importInFlight = true;
    void handleStartIngest(message).finally(() => {
      importInFlight = false;
    });
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
    void handleStartImport(message).finally(() => {
      importInFlight = false;
    });
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
