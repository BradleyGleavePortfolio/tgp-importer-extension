// Flag-discipline gate (R109 / NO-DARK-MERGES).
//
// The extension has exactly ONE path from "no session" to "have session":
// pairing-code redemption, gated by PAIRING_ENABLED. Shipping that flag OFF
// leaves the build with no reachable way to authenticate — a dark-merged auth
// dead-end. This gate pins the invariant mechanically: PAIRING_ENABLED must be
// declared as a boolean literal and, because its backend contract is merged,
// must be `true`. If the backend is ever rolled back the flag may be set false
// ONLY together with removing/guarding the redeem call, which this gate does not
// block — it only forbids a silent regression to a default-off sole auth path.
//
// Usage: node scripts/check-flag-discipline.mjs
import { readFileSync } from "node:fs";

const PROTOCOL = "shared/protocol.js";
const src = readFileSync(PROTOCOL, "utf8");

const match = src.match(
  /export\s+const\s+PAIRING_ENABLED\s*=\s*(true|false)\s*;/,
);
if (!match) {
  process.stdout.write(
    `FAIL: ${PROTOCOL} must declare "export const PAIRING_ENABLED = <boolean literal>;"\n`,
  );
  process.exit(1);
}

const value = match[1];
process.stdout.write(
  `flag discipline — PAIRING_ENABLED=${value} (sole auth path)\n`,
);

if (value !== "true") {
  process.stdout.write(
    "FAIL: PAIRING_ENABLED is the ONLY auth path and its backend contract is merged; " +
      "shipping it false is a dark-merged auth dead-end (R109). Set it true, or roll it " +
      "back in lockstep with guarding the redeem call.\n",
  );
  process.exit(1);
}
process.stdout.write(
  "OK: sole auth path is enabled — no dark-merged dead-end\n",
);
