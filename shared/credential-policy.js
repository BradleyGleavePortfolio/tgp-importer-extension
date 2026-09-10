const REDACTION = "[REDACTED]";
const CREDENTIAL_KEYS = new Set([
    "access_token", "refresh_token", "id_token", "auth_token", "bearer_token", "session_token",
    "session_id", "client_secret", "private_key", "password_hash", "token", "jwt", "api_key",
    "x_api_key", "authorization", "cookie", "set_cookie",
    "password", "passwd", "pwd", "passcode", "secret", "api_secret", "credit_card",
    "card_number", "pan", "cvv", "cvc", "card_security_code", "cookies", "auth", "session",
]);
const COMPACT_KEYS = new Set([...CREDENTIAL_KEYS].map((key) => key.replaceAll("_", "")));
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+/gi;
const BASIC = /\bBasic\s+[A-Za-z0-9+/]+={0,2}(?![A-Za-z0-9+/=])/gi;
const JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
// UTS #39-style skeleton for the Greek/Cyrillic characters confusable with
// Latin credential aliases. Single-script international keys remain ordinary.
const CONFUSABLE_GROUPS = [["a", "ΑАαа"], ["b", "ΒВβ"], ["c", "ϹСϲс"], ["d", "Ꭰԁԃ"],
    ["e", "ΕЕеҽ"], ["g", "Ԍԍ"], ["h", "ΗНһ"], ["i", "ΙІі"], ["j", "Јј"], ["k", "ΚКκк"],
    ["l", "ӏ"], ["m", "ΜМм"], ["n", "Νոп"], ["o", "Оοо"], ["p", "ΡРρр"], ["s", "Ѕѕ"],
    ["t", "ΤТτт"], ["u", "υս"], ["v", "νѵ"], ["x", "ΧХχх"], ["y", "ΥҮуү"], ["z", "Ζζ"]];
const CONFUSABLE = new Map(CONFUSABLE_GROUPS.flatMap(([latin, chars]) => [...chars].map((char) => [char, latin])));
const MIXED_CONFUSABLE = /[\p{Script=Greek}\p{Script=Cyrillic}]/u;
function canonicalCredentialKey(key) {
    return typeof key !== "string" ? "" : key.normalize("NFKD")
        .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function credentialSkeleton(key) { return [...key.normalize("NFKD")
    .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "").toLowerCase()]
    .map((char) => CONFUSABLE.get(char) ?? char).join("").replace(/[^a-z0-9]/g, ""); }
function isCredentialKey(key) {
    if (typeof key !== "string" || key.length > 128) return false;
    const normalized = key.normalize("NFKC");
    const canonical = canonicalCredentialKey(normalized);
    if (CREDENTIAL_KEYS.has(canonical) || COMPACT_KEYS.has(canonical.replaceAll("_", ""))) return true;
    return /[A-Za-z]/.test(normalized) && MIXED_CONFUSABLE.test(normalized) &&
        COMPACT_KEYS.has(credentialSkeleton(normalized));
}
function redactCredentialText(value) { if (typeof value !== "string") return value;
    const normalized = value.normalize("NFKC");
    const redacted = normalized.replace(BEARER, REDACTION).replace(BASIC, REDACTION).replace(JWT, REDACTION);
    return redacted === normalized ? value : redacted;
}
export { REDACTION, canonicalCredentialKey, credentialSkeleton, isCredentialKey, redactCredentialText };
