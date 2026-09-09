const REDACTION = "[REDACTED]";
const CREDENTIAL_KEYS = new Set([
    "access_token", "refresh_token", "id_token", "auth_token", "bearer_token",
    "session_token", "session_id", "client_secret", "private_key", "password_hash",
    "token", "jwt", "api_key", "x_api_key", "authorization", "cookie", "set_cookie",
    "password", "secret", "credit_card",
]);
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const GREEK_OR_CYRILLIC = /[\p{Script=Greek}\p{Script=Cyrillic}]/u;
function canonicalCredentialKey(key) {
    return typeof key === "string"
        ? key.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
            .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
        : "";
}
function isCredentialKey(key) {
    return typeof key === "string" && key.length <= 128 && ((normalized) => { if (CREDENTIAL_KEYS.has(canonicalCredentialKey(normalized))) return true; const skeleton = normalized.toLowerCase().replace(/[^a-z0-9]/g, ""); return /[A-Za-z]/.test(normalized) && GREEK_OR_CYRILLIC.test(normalized) && [...CREDENTIAL_KEYS].some((candidate) => { const expected = candidate.replaceAll("_", ""); let index = 0; for (const char of expected) if (char === skeleton[index]) index += 1; return expected.length - skeleton.length >= 1 && expected.length - skeleton.length <= 2 && index === skeleton.length; }); })(key.normalize("NFKC"));
}
function redactCredentialText(value) {
    return typeof value === "string" ? value.replace(BEARER, REDACTION).replace(JWT, REDACTION) : value;
}
export { REDACTION, canonicalCredentialKey, isCredentialKey, redactCredentialText };
