import { describe, expect, it } from "vitest";
import {
  REDACTION,
  canonicalCredentialKey,
  credentialTokens,
  isCredentialKey,
  isCredentialValue,
  redactCredentialText,
} from "../shared/credential-policy.js";

const REQUIRED_ALIASES = [
  "access_token",
  "refresh_token",
  "id_token",
  "auth_token",
  "oauth_token",
  "bearer_token",
  "session_token",
  "session_id",
  "sid",
  "jsessionid",
  "phpsessid",
  "csrf_token",
  "xsrf_token",
  "client_secret",
  "private_key",
  "secret_key",
  "access_key",
  "access_key_id",
  "password_hash",
  "token",
  "jwt",
  "api_key",
  "x_api_key",
  "x_auth_token",
  "authorization",
  "proxy_authorization",
  "cookie",
  "set_cookie",
  "password",
  "passwd",
  "pwd",
  "passcode",
  "secret",
  "api_secret",
  "credit_card",
  "card_number",
  "cc_number",
  "credit_card_number",
  "card_pan",
  "primary_account_number",
  "cvv",
  "cvc",
  "card_cvv",
  "card_cvc",
  "card_security_code",
  "security_code",
  "card_expiry",
  "expiry_month",
  "expiry_year",
  "routing_number",
  "account_number",
  "payment_token",
  "passphrase",
  "otp",
  "pin",
  "cookies",
  "auth",
  "session",
  "pan",
  "key",
  "credential",
  "signature",
  "sig",
];

const COMPOUND_ALIASES = [
  "accessToken",
  "refreshToken",
  "idToken",
  "authToken",
  "oauthToken",
  "bearerToken",
  "sessionToken",
  "sessionId",
  "csrfToken",
  "xsrfToken",
  "clientSecret",
  "privateKey",
  "secretKey",
  "accessKey",
  "accessKeyId",
  "passwordHash",
  "apiKey",
  "xApiKey",
  "xAuthToken",
  "proxyAuthorization",
  "setCookie",
  "apiSecret",
  "creditCard",
  "cardNumber",
  "ccNumber",
  "creditCardNumber",
  "cardPan",
  "primaryAccountNumber",
  "cardCvv",
  "cardCvc",
  "cardSecurityCode",
  "securityCode",
  "cardExpiry",
  "expiryMonth",
  "expiryYear",
  "routingNumber",
  "accountNumber",
  "paymentToken",
];

const VENDOR_ALIASES = [
  "X-CSRF-Token",
  "X-CSRFToken",
  "X-XSRF-TOKEN",
  "X-Access-Token",
  "X-Refresh-Token",
  "X-OAuth-Token",
  "X-Session-Token",
  "X-Id-Token",
  "X-Authorization",
  "authorization_token",
  "oauth2_token",
  "authKey",
  "sessionKey",
  "X-Amz-Security-Token",
  "X-Goog-Api-Key",
  "X-Gitlab-Token",
  "Stripe-Secret-Key",
  "X-Amz-Credential",
  "X-Amz-Signature",
  "X-Amz-Sig",
  "X-Goog-Credential",
  "X-Goog-Signature",
  "X-Goog-Sig",
];

const SEPARATOR_CASES = [
  "vendor-token",
  "vendor_token",
  "vendor.token",
  "vendor/token",
  "vendor:token",
  "vendor token",
  "vendor+token",
  "vendor@token",
  "vendor#token",
  "vendor--token",
  "vendor__token",
  "vendor..token",
  "-vendor-token-",
  "__vendor_token__",
  "x-api-key",
  "x.api.key",
  "x/api/key",
  "x:api:key",
  "proxy-authorization",
  "client-secret",
  "session-id",
  "payment-token",
];

const CASE_TRANSITIONS = [
  "VendorToken",
  "vendorToken",
  "VENDOR_TOKEN",
  "vendor_TOKEN",
  "VendorCredential",
  "vendorCredential",
  "VENDOR_CREDENTIAL",
  "VendorSignature",
  "vendorSignature",
  "VENDOR_SIGNATURE",
  "XHubSignature",
  "XSignature",
  "StripeSignature",
  "GitHubToken",
  "GitLabAuth",
  "OAuthToken",
  "APIKey",
  "ApiKey",
  "apiKEY",
  "ClientSecret",
  "CLIENT_SECRET",
  "ProxyAuthorization",
  "PROXY_AUTHORIZATION",
  "SessionKey",
];

const VERSIONED_OR_ALGORITHMIC = [
  "X-Hub-Signature-256",
  "X-Signature-Ed25519",
  "X-Signature-SHA256",
  "Vendor-Credential-v2",
  "Stripe-Signature-v1",
  "X-Signature-512",
  "X-Signature-v3",
  "X-Signature-v42",
  "X-Signature-SHA1",
  "X-Signature-SHA384",
  "X-Signature-SHA512",
  "X-Signature-MD5",
  "X-Signature-Ed448",
  "X-Signature-ECDSA",
  "X-Signature-ECDSA256",
  "X-Signature-RSA",
  "X-Signature-RSA4096",
  "X-Signature-AES256",
  "X-Signature-HS256",
  "X-Signature-RS256",
  "X-Signature-ES384",
  "X-Signature-HMAC-SHA256",
  "vendor_token_256",
  "vendor_token_v1",
  "vendorTokenV2",
  "VendorCredentialV2",
  "StripeSignatureV1",
  "xSignatureSHA256",
  "xSignatureEd25519",
  "X_SIGNATURE_SHA256",
  "X_SIGNATURE_ED25519",
  "X_SIGNATURE_V2",
];

const NFKC_EQUIVALENTS = [
  ["ＡＰＩ＿ＫＥＹ", "api_key"],
  ["Ｘ－Ｈｕｂ－Ｓｉｇｎａｔｕｒｅ－２５６", "x_hub_signature_256"],
  ["Ｖｅｎｄｏｒ－Ｃｒｅｄｅｎｔｉａｌ－ｖ２", "vendor_credential_v2"],
  ["Ｓｔｒｉｐｅ－Ｓｉｇｎａｔｕｒｅ－ｖ１", "stripe_signature_v1"],
  ["ApiKey", "api_key"],
  ["ſessionToken", "session_token"],
  ["ⓐⓟⓘ_ⓚⓔⓨ", "api_key"],
  ["ｘ＿ａｕｔｈ＿ｔｏｋｅｎ", "x_auth_token"],
  ["ＣｌｉｅｎｔＳｅｃｒｅｔ", "client_secret"],
  ["ＰｒｏｘｙＡｕｔｈｏｒｉｚａｔｉｏｎ", "proxy_authorization"],
];

const BENIGN_NEAR_MISSES = [
  "monkey",
  "turkey",
  "donkey",
  "hockey",
  "jockey",
  "keynote",
  "keyboard",
  "keyboard-shortcut",
  "keyframe",
  "keyhole",
  "keypad-layout",
  "tokenizer",
  "tokenization",
  "tokens",
  "token-count",
  "token_count",
  "token-limit",
  "token-type",
  "signature-status",
  "signature-method",
  "signature-valid",
  "credential-status",
  "credential-type",
  "credential-provider",
  "authenticator",
  "authentication",
  "authentication-status",
  "auth-provider",
  "auth_provider_name",
  "auth-method",
  "session-duration",
  "session-duration-minutes",
  "session_duration_minutes",
  "session-count",
  "session-state",
  "session-timeout",
  "secretary",
  "secretion",
  "passwordless",
  "passcode-length",
  "authorization-status",
  "authorization-server",
  "authorization-method",
  "public",
  "public-value",
  "cardinality",
  "discard",
  "account-name",
  "routing-strategy",
  "expiry-warning",
  "pinwheel",
  "pinterest",
  "signal",
  "signed",
  "assign",
  "assignment",
  "designature",
  "v2-signature-status",
  "sha256-digest",
  "ed25519-public",
  "bearer",
  "basic",
  "",
  "---",
  "123456",
];

describe("credential-name grammar", () => {
  it("keeps the cumulative alias inventory classified", () => {
    expect(REQUIRED_ALIASES).toHaveLength(63);
    for (const key of REQUIRED_ALIASES) {
      expect(isCredentialKey(key), key).toBe(true);
      expect(isCredentialValue(key, "any-value"), key).toBe(true);
    }
  });

  it("recognizes compact camel-case forms of established aliases", () => {
    expect(COMPOUND_ALIASES).toHaveLength(38);
    for (const key of COMPOUND_ALIASES) {
      expect(isCredentialKey(key), key).toBe(true);
    }
  });

  it("recognizes cumulative vendor and prefixed aliases", () => {
    expect(VENDOR_ALIASES).toHaveLength(23);
    for (const key of VENDOR_ALIASES) {
      expect(isCredentialKey(key), key).toBe(true);
    }
  });

  it("treats punctuation and whitespace as token boundaries", () => {
    for (const key of SEPARATOR_CASES) {
      expect(isCredentialKey(key), key).toBe(true);
    }
  });

  it("detects credential components across common case transitions", () => {
    for (const key of CASE_TRANSITIONS) {
      expect(isCredentialKey(key), key).toBe(true);
    }
  });

  it("detects credential components despite attacker-controlled casing", () => {
    expect(isCredentialKey("X-VENDOR-CreDential-V7")).toBe(true);
    expect(isCredentialValue("X-VENDOR-CreDential-V7", "RAW")).toBe(true);
  });

  it("accepts algorithm and version qualifiers after a credential component", () => {
    for (const key of VERSIONED_OR_ALGORITHMIC) {
      expect(isCredentialKey(key), key).toBe(true);
    }
  });

  it.each(NFKC_EQUIVALENTS)(
    "normalizes compatibility form %s to %s",
    (key, canonical) => {
      expect(canonicalCredentialKey(key)).toBe(canonical);
      expect(isCredentialKey(key)).toBe(true);
    },
  );

  it("does not use unrestricted credential substrings", () => {
    expect(BENIGN_NEAR_MISSES.length).toBeGreaterThanOrEqual(60);
    for (const key of BENIGN_NEAR_MISSES) {
      expect(isCredentialKey(key), key).toBe(false);
      expect(isCredentialValue(key, "ordinary"), key).toBe(false);
    }
  });

  it("does not exempt credential-shaped keys longer than 128 characters", () => {
    const longPrefix = "vendor-segment-".repeat(12);
    const longKey = `${longPrefix}signature-SHA256`;
    expect(longKey.length).toBeGreaterThan(128);
    expect(isCredentialKey(longKey)).toBe(true);
    expect(isCredentialValue(longKey, "secret")).toBe(true);
  });

  it("keeps long benign names benign", () => {
    const longBenign = `${"ordinary-segment-".repeat(12)}display-name`;
    expect(longBenign.length).toBeGreaterThan(128);
    expect(isCredentialKey(longBenign)).toBe(false);
  });

  it("returns false for non-string names without coercion", () => {
    for (const key of [
      null,
      undefined,
      0,
      1,
      false,
      true,
      {},
      [],
      Symbol("key"),
    ]) {
      expect(isCredentialKey(key)).toBe(false);
      expect(canonicalCredentialKey(key)).toBe("");
      expect(credentialTokens(key)).toEqual([]);
    }
  });
});

describe("canonical token boundaries", () => {
  it.each([
    ["X-Hub-Signature-256", ["x", "hub", "signature", "256"]],
    ["X-Signature-Ed25519", ["x", "signature", "ed25519"]],
    ["X-Signature-SHA256", ["x", "signature", "sha256"]],
    ["Vendor-Credential-v2", ["vendor", "credential", "v2"]],
    ["Stripe-Signature-v1", ["stripe", "signature", "v1"]],
    ["clientSecret", ["client", "secret"]],
    ["ProxyAuthorization", ["proxy", "authorization"]],
    ["APIKey", ["api", "key"]],
    ["vendor.token", ["vendor", "token"]],
    [" vendor / token ", ["vendor", "token"]],
  ])("tokenizes %s", (key, expected) => {
    expect(credentialTokens(key)).toEqual(expected);
  });

  it.each([
    ["monkey", ["monkey"]],
    ["turkey", ["turkey"]],
    ["keyboard-shortcut", ["keyboard", "shortcut"]],
    ["token-count", ["token", "count"]],
    ["sessionDuration", ["session", "duration"]],
    ["authProviderName", ["auth", "provider", "name"]],
  ])("preserves benign lexical units in %s", (key, expected) => {
    expect(credentialTokens(key)).toEqual(expected);
    expect(isCredentialKey(key)).toBe(false);
  });
});

describe("credential-shaped text redaction", () => {
  it.each([
    ["Bearer abcDEF123", REDACTION],
    ["bearer token.with-parts_123", REDACTION],
    ["prefix Bearer abcDEF123 suffix", `prefix ${REDACTION} suffix`],
    ["Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==", REDACTION],
    ["basic dXNlcjpwYXNz", REDACTION],
    ["prefix Basic dXNlcjpwYXNz suffix", `prefix ${REDACTION} suffix`],
    ["eyJhbGciOiJIUzI1NiJ9.payload.signature", REDACTION],
    [
      "prefix eyJhbGciOiJIUzI1NiJ9.payload.signature suffix",
      `prefix ${REDACTION} suffix`,
    ],
    ["Bearer one Basic dHdvOnRocmVl", `${REDACTION} ${REDACTION}`],
  ])("redacts %s", (input, expected) => {
    expect(redactCredentialText(input)).toBe(expected);
  });

  it.each([
    "ordinary text",
    "Bearer",
    "Bearer ",
    "Bearer !invalid",
    "Basic",
    "Basic ",
    "Basic *notbase64",
    "eyJ.only-two",
    "not.a.jwt",
    "header.payload.signature",
    "monkey turkey keyboard-shortcut",
    "",
  ])("preserves non-credential text %j", (input) => {
    expect(redactCredentialText(input)).toBe(input);
  });

  it("normalizes compatibility characters only when redaction occurs", () => {
    const fullwidth = "Ｂｅａｒｅｒ secret";
    expect(redactCredentialText(fullwidth)).toBe(REDACTION);
    expect(redactCredentialText("ｏｒｄｉｎａｒｙ")).toBe("ｏｒｄｉｎａｒｙ");
  });

  it("returns non-string values unchanged", () => {
    for (const value of [null, undefined, 0, 42, false, true]) {
      expect(redactCredentialText(value)).toBe(value);
    }
    const object = { authorization: "not traversed here" };
    expect(redactCredentialText(object)).toBe(object);
  });
});
