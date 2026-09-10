const REDACTION = "[REDACTED]", CREDENTIAL_KEYS = new Set(`access_token refresh_token id_token auth_token oauth_token bearer_token
session_token session_id sid jsessionid phpsessid csrf_token xsrf_token client_secret private_key secret_key
access_key access_key_id password_hash token jwt api_key x_api_key x_auth_token authorization proxy_authorization
cookie set_cookie password passwd pwd passcode secret api_secret credit_card card_number cc_number credit_card_number
card_pan primary_account_number cvv cvc card_cvv card_cvc card_security_code security_code card_expiry expiry_month
expiry_year routing_number account_number payment_token passphrase otp pin cookies auth session pan key`.split(/\s+/));
const COMPACT_KEYS = new Set([...CREDENTIAL_KEYS].map((key) => key.replaceAll("_", "")));
const SUFFIXES = `security_token api_key secret_key access_token refresh_token oauth_token csrf_token xsrf_token id_token session_token authorization token secret key`.split(/\s+/).map((key) => key.replaceAll("_", ""));
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+/gi, BASIC = /\bBasic\s+[A-Za-z0-9+/]+={0,2}(?![A-Za-z0-9+/=])/gi;
const JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const CONFUSABLE_GROUPS = [["a", "ΑАαа"], ["b", "ΒВβ"], ["c", "ϹСϲс"], ["d", "Ꭰԁԃ"], ["e", "ΕЕеҽ"], ["g", "Ԍԍ"], ["h", "ΗНһ"], ["i", "ΙІі"], ["j", "Јј"], ["k", "ΚКκк"],
    ["l", "ӏ"], ["m", "ΜМм"], ["n", "Νոп"], ["o", "Оοо"], ["p", "ΡРρр"], ["s", "Ѕѕ"], ["t", "ΤТτт"], ["u", "υս"], ["v", "νѵ"], ["x", "ΧХχх"], ["y", "ΥҮуү"], ["z", "Ζζ"]];
const CONFUSABLE = new Map(CONFUSABLE_GROUPS.flatMap(([latin, chars]) => [...chars].map((char) => [char, latin])));
const MIXED_CONFUSABLE = /[\p{Script=Greek}\p{Script=Cyrillic}]/u;
function canonicalCredentialKey(key) {
    return typeof key !== "string" ? "" : key.normalize("NFKD").replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function credentialSkeleton(key) { return [...key.normalize("NFKD").replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "").toLowerCase()]
    .map((char) => CONFUSABLE.get(char) ?? char).join("").replace(/[^a-z0-9]/g, ""); }
function isCredentialKey(key) {
    if (typeof key !== "string" || key.length > 128) return false;
    const normalized = key.normalize("NFKC");
    const canonical = canonicalCredentialKey(normalized),
        ascii = normalized.normalize("NFKD").replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "");
    const compact = canonical.replaceAll("_", "");
    if (/^[\x00-\x7F]*$/.test(ascii) && (COMPACT_KEYS.has(compact) ||
        SUFFIXES.some((suffix) => compact.length > suffix.length && compact.endsWith(suffix)))) return true;
    return /[A-Za-z]/.test(normalized) && MIXED_CONFUSABLE.test(normalized) &&
        COMPACT_KEYS.has(credentialSkeleton(normalized));
}
function isCredentialValue(key, value) { if (!isCredentialKey(key)) return false;
    const compact = canonicalCredentialKey(key).replaceAll("_", "");
    if (!new Set(["auth", "session", "pan"]).has(compact)) return true;
    return typeof value === "string" && value.length >= 8 && !/\s/.test(value) && /[^A-Za-z]/.test(value); }
function redactCredentialText(value) {
    if (typeof value !== "string") return value; const normalized = value.normalize("NFKC");
    const redacted = normalized.replace(BEARER, REDACTION).replace(BASIC, REDACTION).replace(JWT, REDACTION);
    return redacted === normalized ? value : redacted;
}
export { REDACTION, canonicalCredentialKey, credentialSkeleton, isCredentialKey, isCredentialValue, redactCredentialText };
