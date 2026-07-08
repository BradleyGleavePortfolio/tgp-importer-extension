// Capture policy for the TGP Importer (see docs/AUTO_DISCOVERY.md §6 and
// docs/CAPTURE_MODEL.md).
//
// Two policies live here, both enforced BEFORE anything sensitive happens:
//
//   1. Debugger origin allowlist — the `debugger` permission is ambient
//      authority over any tab, so attach is gated on an explicit HTTPS host
//      allowlist. chrome://, devtools://, file://, extension pages, plain
//      HTTP, and every non-allowlisted host (including TGP's own auth
//      surface) are rejected before chrome.debugger.attach is ever called.
//
//   2. Response-body secret redaction — captured JSON bodies are walked and
//      any auth/secret-bearing field (tokens, api keys, cookies, passwords)
//      is replaced with "[REDACTED]" before the entry enters the buffer.
//      Non-secret PII (names, emails) is intentionally preserved — that is
//      the material being imported; only credential material is stripped.
//
// R75: zero banned type-assertions — every narrowing is a real guard.
// R76: this file stays comfortably under 400 LOC.

// Hosts the coach may capture from. Grows with docs/ROADMAP.md platforms
// (e.g. "my.trainerize.com", "mypthub.net") — additions only via PR review.
const ALLOWED_CAPTURE_HOSTS = new Set([
    "app.truecoach.co",
]);

// Resolve a tab and assert its URL is eligible for capture. Throws a stable
// machine-readable error code on every rejection path; returns the tab on
// success so callers can reuse the lookup.
async function assertCaptureTabAllowed(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || typeof tab.url !== "string" || tab.url.length === 0) {
        throw new Error("capture_no_url");
    }
    let url;
    try {
        url = new URL(tab.url);
    }
    catch {
        throw new Error("capture_bad_url");
    }
    if (url.protocol !== "https:") {
        throw new Error("capture_non_https");
    }
    if (!ALLOWED_CAPTURE_HOSTS.has(url.hostname)) {
        throw new Error("capture_host_not_allowed");
    }
    return tab;
}

// ---- response-body secret redaction ------------------------------------------

const BODY_REDACTED = "[REDACTED]";

// Auth/secret field names, matched case-insensitively against object keys.
// Deliberately NOT a substring match: "token_count" or "secret_santa_notes"
// style fields would be data loss, and non-secret PII must survive intact.
const SENSITIVE_BODY_KEY = new RegExp(
    "^(access_token|refresh_token|id_token|token|api_key|authorization|" +
    "cookie|set-cookie|password|secret)$",
    "i",
);

// Fallbacks for bodies that are not JSON objects: bearer credentials and
// JWT-shaped compact tokens embedded in text.
const BEARER_PATTERN = /Bearer [A-Za-z0-9._-]+/g;
const JWT_PATTERN = /eyJ[A-Za-z0-9._-]+/g;

function isRecord(value) {
    return typeof value === "object" && value !== null;
}

// Recursively redact sensitive keys in a parsed JSON value, in place.
// Returns true when at least one value was replaced.
function redactParsedValue(value) {
    let changed = false;
    if (Array.isArray(value)) {
        for (const item of value) {
            changed = redactParsedValue(item) || changed;
        }
        return changed;
    }
    if (!isRecord(value)) {
        return false;
    }
    for (const [key, child] of Object.entries(value)) {
        if (SENSITIVE_BODY_KEY.test(key)) {
            value[key] = BODY_REDACTED;
            changed = true;
        }
        else {
            changed = redactParsedValue(child) || changed;
        }
    }
    return changed;
}

// Regex fallback for non-JSON (or JSON-primitive) bodies: strip bearer
// credentials and JWT-shaped tokens, preserve everything else verbatim.
function redactTokenText(text) {
    return text.replace(BEARER_PATTERN, BODY_REDACTED).replace(JWT_PATTERN, BODY_REDACTED);
}

// Redact auth/secret material from a captured response body string before it
// is stored. JSON bodies are parsed, walked, and re-serialized ONLY when a
// redaction occurred, so untainted bodies are preserved byte-for-byte.
function redactResponseBody(body) {
    if (typeof body !== "string" || body.length === 0) {
        return body;
    }
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        return redactTokenText(body);
    }
    if (!isRecord(parsed)) {
        // JSON primitive (string/number/bool) — no keys to walk, but a bare
        // string can still carry a token.
        return redactTokenText(body);
    }
    return redactParsedValue(parsed) ? JSON.stringify(parsed) : body;
}

export {
    ALLOWED_CAPTURE_HOSTS,
    BODY_REDACTED,
    assertCaptureTabAllowed,
    redactResponseBody,
};
