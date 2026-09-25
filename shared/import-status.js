// TGP Importer — read-only consumer of GET /api/scout/import/status.
//
// Shape frozen from the landed backend contract (growth-project-backend
// integration/importer df713fd9, docs/contracts/importer-openapi.json
// 2.0.0-c1-s2.0); the test fixture carries the verbatim schemas. Only the
// fields this consumer displays are validated, strictly; every other field is
// ignored so an additive contract change cannot break the read.
//
// Truth rules: a 404 is the backend's uniform "no evidence / dark route" answer
// and means NOT YET KNOWN (never 0, never failed). Committed counts are kept per
// family and never summed. The server's terminal is the final state; the
// extension's own `claimed_status` is never read as the result.
import { discardBody, readBoundedJson } from "./net.js";

export const IMPORT_STATUS_PATH = "/api/scout/import/status";

// A status body is a few hundred bytes per family; far above any real reply.
export const MAX_STATUS_BODY_BYTES = 65536;
const MAX_FAMILIES = 32;
const MAX_FAMILY_NAME = 64;

export const SERVER_STATUSES = [
  "running",
  "success",
  "partial",
  "failed",
  "complete",
  "blocked",
  "cancelled",
  "timed_out",
];
const MODES = ["legacy", "server"];

// The contract bounds intent_id to 1..128; anything else is never sent.
export function isSendableIntentId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 128;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validate a 200 body against the consumed subset. Returns the normalized
// reply or null (caller reports "could not check" — never a guessed state).
export function parseImportStatus(body, intentId) {
  if (!isRecord(body) || body.intent_id !== intentId) return null;
  if (!SERVER_STATUSES.includes(body.status)) return null;
  if (!MODES.includes(body.mode)) return null;
  if (body.completed_at !== null && typeof body.completed_at !== "string")
    return null;
  if (
    !Array.isArray(body.entity_counts) ||
    body.entity_counts.length > MAX_FAMILIES
  )
    return null;
  const seen = new Set();
  const counts = [];
  for (const row of body.entity_counts) {
    if (
      !isRecord(row) ||
      typeof row.entity_type !== "string" ||
      row.entity_type.length === 0 ||
      row.entity_type.length > MAX_FAMILY_NAME ||
      seen.has(row.entity_type) ||
      !Number.isSafeInteger(row.committed) ||
      row.committed < 0
    )
      return null;
    seen.add(row.entity_type);
    counts.push({ entityType: row.entity_type, committed: row.committed });
  }
  return {
    state: "known",
    intentId,
    status: body.status,
    mode: body.mode,
    settled: body.status !== "running",
    counts,
  };
}

// fetchWithTimeout consumer: classify one HTTP reply inside the request
// deadline. `http` lets the caller decide on a single bound refresh for 401.
export async function readImportStatusReply(response, intentId, signal) {
  const http =
    response && typeof response.status === "number" ? response.status : 0;
  if (http === 200) {
    let body;
    try {
      body = await readBoundedJson(response, signal, MAX_STATUS_BODY_BYTES);
    } catch {
      return { http, reply: unavailableServerStatus() };
    }
    const parsed = parseImportStatus(body, intentId);
    return { http, reply: parsed ?? unavailableServerStatus() };
  }
  // Error bodies are never read or shown; only the status class matters.
  discardBody(response);
  if (http === 404) {
    return { http, reply: { state: "not_yet_known", intentId } };
  }
  return { http, reply: unavailableServerStatus() };
}

export function unavailableServerStatus() {
  return { state: "unavailable" };
}
