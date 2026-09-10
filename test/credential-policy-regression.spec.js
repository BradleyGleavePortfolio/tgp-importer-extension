import { describe, expect, it } from "vitest";
import {
  isCredentialKey,
  isCredentialValue,
} from "../shared/credential-policy.js";
import { redactHeaders, redactUrl } from "../shared/capture.js";
import { BODY_REDACTED, redactResponseBody } from "../shared/capture-policy.js";

const ORIGINAL =
  `access_token refresh_token id_token auth_token oauth_token bearer_token session_token session_id sid
jsessionid phpsessid csrf_token xsrf_token client_secret private_key secret_key access_key access_key_id password_hash
token jwt api_key x_api_key x_auth_token authorization proxy_authorization cookie set_cookie password passwd pwd passcode
secret api_secret credit_card card_number cc_number credit_card_number card_pan primary_account_number cvv cvc card_cvv
card_cvc card_security_code security_code card_expiry expiry_month expiry_year routing_number account_number payment_token
passphrase otp pin cookies`.split(/\s+/);
const ROUND_5 =
  `X-CSRF-Token X-CSRFToken X-XSRF-TOKEN X-Access-Token X-Refresh-Token X-OAuth-Token
X-Session-Token X-Id-Token X-Authorization authorization_token oauth2_token`.split(
    /\s+/,
  );
const ROUND_6 = [
  "auth",
  "session",
  "pan",
  "key",
  "authKey",
  "sessionKey",
  "X-Amz-Security-Token",
  "X-Goog-Api-Key",
  "X-Gitlab-Token",
  "Stripe-Secret-Key",
];

describe("credential policy consolidated regression matrix", () => {
  it.each([...ORIGINAL, ...ROUND_5, ...ROUND_6])(
    "classifies and redacts %s on every capture surface",
    (key) => {
      const secret = "plain-secret-credential";
      expect(isCredentialKey(key)).toBe(true);
      expect(redactHeaders({ [key]: secret })[key]).toBe("<redacted>");
      expect(
        new URL(
          redactUrl(
            `https://coach.example/x?${encodeURIComponent(key)}=${secret}`,
          ),
        ).searchParams.get(key),
      ).toBe("<redacted>");
      expect(
        JSON.parse(redactResponseBody(JSON.stringify({ [key]: secret })))[key],
      ).toBe(BODY_REDACTED);
    },
  );

  it.each([
    ["session", { title: "Strength session", duration_minutes: 45 }],
    ["pan", "integral"],
    ["token_count", 3],
    ["session_duration_minutes", 45],
    ["auth_provider_name", "Example Identity"],
  ])("preserves benign non-credential value %s", (key, value) => {
    expect(isCredentialValue(key, value)).toBe(false);
    const body = JSON.stringify({ [key]: value });
    expect(redactResponseBody(body)).toBe(body);
  });
});
