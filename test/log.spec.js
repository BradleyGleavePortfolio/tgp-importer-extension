import { describe, it, expect, vi, afterEach } from "vitest";
import { logNetworkEvent } from "../shared/log.js";

// Coverage of shared/log.js — the safe structured logger the fail-closed catch
// sites use. The contract: it emits exactly one structured, secret-free line;
// it only ever prints an allow-listed event code, so a caller can never smuggle
// token/PII text into the log even by passing it as the "event".

afterEach(() => {
  vi.restoreAllMocks();
});

function captureWarn(fn) {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  fn();
  return spy;
}

describe("logNetworkEvent", () => {
  it("emits a single structured JSON line for a known event", () => {
    const spy = captureWarn(() => logNetworkEvent("pair_timeout"));
    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed).toEqual({ src: "tgp-importer", event: "pair_timeout" });
  });

  it("maps an unknown event to a fixed sentinel — never echoes caller text", () => {
    const spy = captureWarn(() => logNetworkEvent("refresh_token=SUPERSECRET"));
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.event).toBe("unknown_network_event");
    // The secret-looking input must not appear anywhere in the output.
    expect(spy.mock.calls[0][0]).not.toContain("SUPERSECRET");
  });

  it("accepts every documented event code", () => {
    const events = [
      "refresh_network_error",
      "refresh_body_parse_error",
      "refresh_rotation_persist_failed",
      "refresh_timeout",
      "pair_network_error",
      "pair_timeout",
      "pair_body_parse_error",
    ];
    for (const event of events) {
      const spy = captureWarn(() => logNetworkEvent(event));
      expect(JSON.parse(spy.mock.calls[0][0]).event).toBe(event);
      spy.mockRestore();
    }
  });

  it("never throws on odd input and still logs the sentinel", () => {
    for (const bad of [undefined, null, 42, {}]) {
      const spy = captureWarn(() => logNetworkEvent(bad));
      expect(JSON.parse(spy.mock.calls[0][0]).event).toBe(
        "unknown_network_event",
      );
      spy.mockRestore();
    }
  });
});
