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

import { REDACTION as BODY_REDACTED, isCredentialKey, redactCredentialText } from "./credential-policy.js";

function isRecord(value) {
    return typeof value === "object" && value !== null;
}

// Iterative walk avoids attacker-controlled recursion; overflow redacts the
// entire body rather than risking a partially inspected credential payload.
function redactParsedValue(value) {
    let changed = false;
    let nodes = 0;
    const pending = [value];
    while (pending.length > 0) {
        const current = pending.pop();
        if (++nodes > 20000) return null;
        if (Array.isArray(current)) for (const child of current) pending.push(child);
        else if (isRecord(current)) for (const [key, child] of Object.entries(current)) {
            if (isCredentialKey(key)) {
                current[key] = BODY_REDACTED;
                changed = true;
            }
            else if (typeof child === "string" && redactCredentialText(child) !== child) {
                current[key] = redactCredentialText(child);
                changed = true;
            }
            else if (isRecord(child)) pending.push(child);
        }
    }
    return changed;
}

// Regex fallback for non-JSON (or JSON-primitive) bodies: strip bearer
// credentials and JWT-shaped tokens, preserve everything else verbatim.
function redactTokenText(text) {
    return redactCredentialText(text);
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
    const changed = redactParsedValue(parsed);
    return changed === null ? JSON.stringify(BODY_REDACTED) : changed ? JSON.stringify(parsed) : body;
}

export {
    ALLOWED_CAPTURE_HOSTS,
    BODY_REDACTED,
    assertCaptureTabAllowed,
    redactResponseBody,
};
