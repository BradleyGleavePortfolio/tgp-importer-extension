// TGP Importer — pairing-code redemption (the ONLY producer of a session).
//
// docs/DESIGN.md §§2,3,4: the extension's single "no session -> session" path
// is POST /api/extension/pair/redeem { code }. There is NO inline login, no
// OAuth, no signup link. This module performs that redeem and hands the minted
// token pair to the background worker's single session-establishment boundary
// via one `session_established` message. It owns no storage and holds a token
// only within the scope of one redeem call.
//
// Gated behind PAIRING_ENABLED. The redeem endpoint's backend contract
// (growth-project-backend PR #502) is merged, so the flag ships ENABLED for the
// v0.3 RC (R109 / NO-DARK-MERGES: the sole auth path must be live once its
// backend exists). The gate is retained so the flow can be disabled in lockstep
// if the backend contract is ever pulled.
//
// R75: zero banned type-assertions — every narrowing is a real guard.
import { TGP_API_ORIGIN, PAIRING_ENABLED, PAIR_REDEEM_PATH } from "./protocol.js";
import { fetchWithTimeout, isTimeout } from "./net.js";
import { logNetworkEvent } from "./log.js";

const REDEEM_ENDPOINT = `${TGP_API_ORIGIN}${PAIR_REDEEM_PATH}`;

// Structured backend failure codes -> coach-facing copy. Unknown codes fall
// back to a generic message; no raw server text is ever echoed to the coach.
const ERROR_COPY = {
    expired: "That code has expired. Generate a fresh one in the TGP app.",
    already_used: "That code was already used. Generate a fresh one in the TGP app.",
    invalid: "That code isn't valid. Check the digits and try again.",
    locked: "Too many attempts. Wait a moment, then generate a new code.",
};

function readString(record, key) {
    return typeof record === "object" && record !== null && typeof record[key] === "string"
        ? record[key]
        : null;
}
function isOk(value) {
    return typeof value === "object" && value !== null && value.ok === true;
}

// Redeem a 6-digit pairing code and establish the session. Returns
// { ok: true, chosenPlatform } or { ok: false, error } with a coach-facing
// message — never token material. `deps` injects fetch + sendMessage so this is
// unit-testable with no live network and no chrome runtime.
export async function redeemPairingCode(code, deps = {}) {
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const sendMessage = deps.sendMessage ?? ((m) => chrome.runtime.sendMessage(m));
    // The shipped state comes from PAIRING_ENABLED (on for the v0.3 RC).
    // `deps.enabled` lets a test pin either branch explicitly without depending
    // on the shipped flag value. Production callers (pair.js) never pass it.
    const enabled = deps.enabled ?? PAIRING_ENABLED;

    if (!enabled) {
        return { ok: false, error: "Pairing isn't available yet." };
    }
    if (!/^\d{6}$/.test(typeof code === "string" ? code : "")) {
        return { ok: false, error: ERROR_COPY.invalid };
    }

    let res;
    try {
        res = await fetchWithTimeout(fetchImpl, REDEEM_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
        });
    }
    catch (err) {
        if (isTimeout(err)) {
            logNetworkEvent("pair_timeout");
            return { ok: false, error: "That took too long. Check your connection and try again." };
        }
        logNetworkEvent("pair_network_error");
        return { ok: false, error: "Network error. Please try again." };
    }

    // Parse the body explicitly. A malformed/empty body maps to `null` here (not
    // a silent swallow); the null then routes to explicit copy below. We log a
    // PII-free event code — never the body, which could carry server text.
    let body;
    try {
        body = await res.json();
    }
    catch {
        logNetworkEvent("pair_body_parse_error");
        body = null;
    }

    if (!res.ok) {
        const reason = readString(body, "code");
        return { ok: false, error: (reason && ERROR_COPY[reason]) || "Pairing failed. Please try again." };
    }

    const accessToken = readString(body, "access_token");
    const refreshToken = readString(body, "refresh_token");
    if (accessToken === null || refreshToken === null) {
        return { ok: false, error: "Unexpected pairing response." };
    }

    // Hand the token pair to the single owner (background worker). Fail-closed:
    // report success only once the worker acknowledges the session.
    const ack = await sendMessage({ kind: "session_established", accessToken, refreshToken });
    if (!isOk(ack)) {
        return { ok: false, error: "Could not establish session. Please try again." };
    }
    return { ok: true, chosenPlatform: readString(body, "chosen_platform") };
}
