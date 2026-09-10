import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("popup/pair.js sole-signin fail-closed", () => {
  it("chains a .catch so a messaging reject cannot leave submit disabled forever", () => {
    const src = readFileSync(join(process.cwd(), "popup/pair.js"), "utf8");
    expect(src).toMatch(
      /redeemPairingCode\([\s\S]*?\)\s*\.then\([\s\S]*?\)\s*\.catch\(/,
    );
    expect(src).toMatch(/disableSubmit\(false\)/);
    expect(src).toMatch(/Something went wrong pairing this device/);
  });
});
