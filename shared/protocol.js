// Shared message protocol and config for the TGP Importer extension.
// Strongly typed so background, content, popup, and extractor never need casts.
export const TGP_API_ORIGIN = "https://backend-spring-lake-3890.fly.dev";
// The extension's ONLY no-session -> session path (docs/DESIGN.md §§3,4): the
// unauthenticated pairing-code redeem.
//
// Backend flag dependency (R109 resolution): the redeem endpoint
// (`PAIR_REDEEM_PATH`) is delivered by growth-project-backend PR #502
// (IMPORTER-D) and the token-refresh endpoint by PR #496 (IMPORTER-A). Both are
// merged, so pairing — the extension's SOLE auth path — is ENABLED for the v0.3
// release candidate. Shipping it default-OFF would leave the build with no
// reachable way to sign in (a dark-merged auth dead-end); NO-DARK-MERGES
// requires the only auth path to be live once its backend contract exists. The
// `scripts/check-flag-discipline.mjs` CI gate pins this ON so it cannot silently
// regress to a default-off dead-end. If the backend contract is ever pulled,
// flip this to `false` in the SAME change that removes/guards the redeem call.
export const PAIR_REDEEM_PATH = "/api/extension/pair/redeem";
export const PAIRING_ENABLED = true;
// TGP's own origin (the product's backend, not a source). The importer never
// captures from, crawls, or authorizes it as a source. Exactly the API host:
// it lives under a shared hosting domain, so no sibling host is TGP's.
// Owner decision OD-API-ORIGIN (2026-09-29): the backend is the Fly app the
// mobile client already uses; the previous vanity domain was never registered.
const TGP_API_HOSTNAME = new URL(TGP_API_ORIGIN).hostname;
export function isTgpOrigin(origin) {
  if (typeof origin !== "string") return false;
  let hostname;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === TGP_API_HOSTNAME;
}
// Narrowing helpers — avoid `as` casts on untyped chrome.runtime payloads.
export function isStartIngest(m) {
  return isRecord(m) && m.kind === "start_ingest";
}
export function isBearerFound(m) {
  return isRecord(m) && m.kind === "bearer_found";
}
export function isRequestStatus(m) {
  return isRecord(m) && m.kind === "request_status";
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
// Build the /api/scout/ingest batch body. The OUTER envelope is snake_case
// (`intent_id` / `entity_type`) to match the backend ScoutIngestDto verbatim;
// each ENTITY is the untouched makeEntity() output — camelCase
// `{ sourceId, sourcePlatform, capturedAt, payload }` per R80-CLARIFY-1
// (2026-07-07). Entities MUST pass through as-is: no re-mapping, no renaming.
export function makeScoutIngestBody(intentId, entityType, entities) {
  return { intent_id: intentId, entity_type: entityType, entities };
}
