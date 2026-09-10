const REDACTION = "[REDACTED]";

const CREDENTIAL_KEYS = new Set(
  `access_token refresh_token id_token auth_token oauth_token bearer_token
session_token session_id sid jsessionid phpsessid csrf_token xsrf_token
client_secret private_key secret_key access_key access_key_id password_hash
token jwt api_key x_api_key x_auth_token authorization proxy_authorization
cookie set_cookie password passwd pwd passcode secret api_secret credit_card
card_number cc_number credit_card_number card_pan primary_account_number cvv
cvc card_cvv card_cvc card_security_code security_code card_expiry expiry_month
expiry_year routing_number account_number payment_token passphrase otp pin
cookies auth session pan key credential signature sig`
    .split(/\s+/)
    .filter(Boolean),
);

const COMPACT_CREDENTIAL_KEYS = new Set(
  [...CREDENTIAL_KEYS].map((key) => key.replaceAll("_", "")),
);

const CREDENTIAL_COMPONENTS = new Set([
  "auth",
  "authorization",
  "credential",
  "key",
  "secret",
  "session",
  "sig",
  "signature",
  "token",
]);

const TRAILING_QUALIFIER =
  /^(?:\d+|v\d+|hmac|sha\d+|md\d+|ed\d+|ecdsa\d*|rsa\d*|aes\d*|hs\d+|rs\d+|es\d+)$/;

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+/gi;
const BASIC = /\bBasic\s+[A-Za-z0-9+/]+={0,2}(?![A-Za-z0-9+/=])/gi;
const JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

function canonicalCredentialKey(key) {
  if (typeof key !== "string") return "";

  return key
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{Nd}])(\p{Lu})/gu, "$1_$2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function caseInvariantCredentialKey(key) {
  if (typeof key !== "string") return "";

  return key
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function credentialTokens(key) {
  const canonical = canonicalCredentialKey(key);
  return canonical ? canonical.split("_") : [];
}

function hasCredentialComponent(tokens) {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (CREDENTIAL_COMPONENTS.has(token)) {
      return tokens
        .slice(index + 1)
        .every((part) => TRAILING_QUALIFIER.test(part));
    }
    if (!TRAILING_QUALIFIER.test(token)) return false;
  }
  return false;
}

function isCredentialKey(key) {
  const canonical = canonicalCredentialKey(key);
  if (!canonical) return false;

  const invariant = caseInvariantCredentialKey(key);
  return [canonical, invariant].some(
    (candidate) =>
      CREDENTIAL_KEYS.has(candidate) ||
      COMPACT_CREDENTIAL_KEYS.has(candidate.replaceAll("_", "")) ||
      hasCredentialComponent(candidate.split("_")),
  );
}

function isCredentialValue(key, _value) {
  return isCredentialKey(key);
}

function redactCredentialText(value) {
  if (typeof value !== "string") return value;

  const normalized = value.normalize("NFKC");
  const redacted = normalized
    .replace(BEARER, REDACTION)
    .replace(BASIC, REDACTION)
    .replace(JWT, REDACTION);
  return redacted === normalized ? value : redacted;
}

export {
  REDACTION,
  canonicalCredentialKey,
  credentialTokens,
  isCredentialKey,
  isCredentialValue,
  redactCredentialText,
};
