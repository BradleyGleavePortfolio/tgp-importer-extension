// Shared message protocol and config for the TGP Importer extension.
// Strongly typed so background, content, popup, and extractor never need casts.
export const TGP_API_ORIGIN = "https://api.tgp.coach";
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
