// Shared message protocol and config for the TGP Importer extension.
// Strongly typed so background, content, popup, and extractor never need casts.
export const TGP_API_ORIGIN = "https://api.tgp.coach";
// The extension's ONLY no-session -> session path (docs/DESIGN.md §§3,4): the
// unauthenticated pairing-code redeem. The endpoint is a backend dependency
// (IMPORTER-D, PR #502 — not yet built), so the redeem flow ships default-OFF
// via PAIRING_ENABLED and refuses to touch the network until the contract is
// live. Flip PAIRING_ENABLED to true in the same PR that wires the endpoint.
export const PAIR_REDEEM_PATH = "/api/extension/pair/redeem";
export const PAIRING_ENABLED = false;
export const TRUECOACH_ORIGIN = "https://app.truecoach.co";
export const TRUECOACH_API_BASE = "https://app.truecoach.co/proxy/api";
export const STORAGE_KEY_INTENT = "tgp_active_intent";
export const INTENT_QUERY_PARAM = "tgp_intent";
export const DAY1_PLATFORM = "truecoach";
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
