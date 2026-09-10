import { describe, expect, it } from "vitest";
import { CaptureBuffer } from "../shared/capture-buffer.js";
import { normalizeCaptureSnapshot } from "../shared/blueprint/input.js";
import { BODY_REDACTED, redactResponseBody } from "../shared/capture-policy.js";
import { redactHeaders, redactUrl } from "../shared/capture.js";
import {
  isCredentialKey,
  isCredentialValue,
} from "../shared/credential-policy.js";

// Permanent cumulative list: append aliases discovered in future rounds; never remove any.
const ORIGINAL =
  `access_token refresh_token id_token auth_token oauth_token bearer_token session_token session_id sid
jsessionid phpsessid csrf_token xsrf_token client_secret private_key secret_key access_key access_key_id password_hash
token jwt api_key x_api_key x_auth_token authorization proxy_authorization cookie set_cookie password passwd pwd passcode
secret api_secret credit_card card_number cc_number credit_card_number card_pan primary_account_number cvv cvc card_cvv
card_cvc card_security_code security_code card_expiry expiry_month expiry_year routing_number account_number payment_token
passphrase otp pin cookies`.split(/\s+/);
const COMPOUND =
  `accessToken refreshToken idToken authToken oauthToken bearerToken sessionToken sessionId csrfToken xsrfToken
clientSecret privateKey secretKey accessKey accessKeyId passwordHash apiKey xApiKey xAuthToken proxyAuthorization
setCookie apiSecret creditCard cardNumber ccNumber creditCardNumber cardPan primaryAccountNumber cardCvv cardCvc
cardSecurityCode securityCode cardExpiry expiryMonth expiryYear routingNumber accountNumber paymentToken`.split(
    /\s+/,
  );
const ROUND_5 =
  `X-CSRF-Token X-CSRFToken X-XSRF-TOKEN X-Access-Token X-Refresh-Token X-OAuth-Token
X-Session-Token X-Id-Token X-Authorization authorization_token oauth2_token`.split(
    /\s+/,
  );
const ROUND_6 =
  `auth session pan key authKey sessionKey X-Amz-Security-Token X-Goog-Api-Key X-Gitlab-Token
Stripe-Secret-Key`.split(/\s+/);
const ROUND_7 =
  `credential signature sig X-Amz-Credential X-Amz-Signature X-Amz-Sig
X-Goog-Credential X-Goog-Signature X-Goog-Sig`.split(/\s+/);
const ALIASES = [
  ...new Set([...ORIGINAL, ...COMPOUND, ...ROUND_5, ...ROUND_6, ...ROUND_7]),
];
const VALUES = ["alphabeticonly", "1234567890", "Mixed-123_Value"];

describe("permanent cumulative credential capture regression matrix", () => {
  it("retains the complete seven-round alias inventory", () => {
    expect(ALIASES).toHaveLength(124);
  });

  it.each(ALIASES.flatMap((key) => VALUES.map((value) => [key, value])))(
    "redacts %s=%s through capture, buffer, and C2a normalization",
    (key, secret) => {
      expect(isCredentialKey(key)).toBe(true);
      expect(isCredentialValue(key, secret)).toBe(true);
      const buffer = new CaptureBuffer();
      buffer.push({
        url: redactUrl(
          `https://coach.example/api?${encodeURIComponent(key)}=${secret}`,
        ),
        method: "GET",
        requestHeaders: redactHeaders({ [key]: secret }),
        responseBody: redactResponseBody(
          JSON.stringify({
            [key]: secret,
            nested: { [key]: secret },
            rows: [{ [key]: secret }],
          }),
        ),
      });
      const captured = buffer.snapshot();
      expect(captured).toHaveLength(1);
      expect(JSON.stringify(captured)).not.toContain(secret);
      const normalized = normalizeCaptureSnapshot(captured);
      expect(normalized.excluded).toEqual([]);
      expect(JSON.stringify(normalized)).not.toContain(secret);
      expect(normalized.observations[0].body[key]).toBe(BODY_REDACTED);
      expect(normalized.observations[0].body.nested[key]).toBe(BODY_REDACTED);
      expect(normalized.observations[0].body.rows[0][key]).toBe(BODY_REDACTED);
    },
  );

  it.each(["monkey", "donkey", "hockey", "turkey"])(
    "preserves benign key-suffix word %s",
    (key) => {
      expect(isCredentialKey(key)).toBe(false);
      expect(redactResponseBody(JSON.stringify({ [key]: "ordinary" }))).toBe(
        JSON.stringify({ [key]: "ordinary" }),
      );
    },
  );

  it.each([
    ["token_count", 3],
    ["session_duration_minutes", 45],
    ["auth_provider_name", "Example Identity"],
  ])("preserves benign non-credential value %s", (key, value) => {
    expect(isCredentialValue(key, value)).toBe(false);
    const body = JSON.stringify({ [key]: value });
    expect(redactResponseBody(body)).toBe(body);
  });
});
