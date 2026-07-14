// TGP Importer — safe structured logging for the few places that must swallow a
// network/parse failure to fail closed.
//
// The contract: callers pass a stable, PII-free EVENT CODE (never a message
// body, URL with query, token, code, or any error object that could carry one).
// We emit one structured line so a failure is observable in the service-worker
// console without ever recording secrets. This exists so "silent catch" sites
// become "explicit, logged, no-PII catch" sites (docs/DESIGN.md §13.4).
const KNOWN_EVENTS = new Set([
    "refresh_network_error",
    "refresh_body_parse_error",
    "refresh_rotation_persist_failed",
    "pair_network_error",
    "pair_timeout",
    "pair_body_parse_error",
    "refresh_timeout",
]);

// Emit a structured, secret-free warning. `event` MUST be one of KNOWN_EVENTS so
// a typo can never smuggle caller-controlled text into the log line.
export function logNetworkEvent(event) {
    const code = KNOWN_EVENTS.has(event) ? event : "unknown_network_event";
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({ src: "tgp-importer", event: code }));
}
