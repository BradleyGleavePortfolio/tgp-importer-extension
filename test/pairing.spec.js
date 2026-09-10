import { describe, it, expect, vi, afterEach } from "vitest";
import { redeemPairingCode } from "../shared/pairing.js";
import { PAIRING_ENABLED } from "../shared/protocol.js";

// Coverage of shared/pairing.js — the ONLY producer of a session. It redeems a
// 6-digit code against POST /api/extension/pair/redeem and hands the token pair
// to the background worker via one `session_established` message. fetch +
// sendMessage are injected so the production producer path is tested with no
// live network. `enabled` pins either branch of the PAIRING_ENABLED gate without
// depending on the shipped flag value.

const REDEEM_ENDPOINT = "https://api.tgp.coach/api/extension/pair/redeem";

function okFetch(bodyObj, { ok = true, status = 200 } = {}) {
  return vi.fn().mockResolvedValue({ ok, status, json: async () => bodyObj });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PAIRING_ENABLED gate (R109 / NO-DARK-MERGES)", () => {
  it("ships ENABLED for the v0.3 RC — the sole auth path is live", () => {
    // The whole point of R109: the only route from no-session to session must
    // not be dark-merged off once its backend contract exists.
    expect(PAIRING_ENABLED).toBe(true);
  });

  it("when explicitly disabled, refuses to touch the network", async () => {
    const fetchImpl = vi.fn();
    const sendMessage = vi.fn();
    const res = await redeemPairingCode("123456", {
      enabled: false,
      fetch: fetchImpl,
      sendMessage,
    });
    expect(res).toEqual({ ok: false, error: "Pairing isn't available yet." });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("with the shipped default (no explicit enabled) it proceeds to redeem", async () => {
    const fetchImpl = okFetch({
      access_token: "acc",
      refresh_token: "ref",
      chosen_platform: "truecoach",
    });
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const res = await redeemPairingCode("123456", {
      fetch: fetchImpl,
      sendMessage,
    });
    expect(res).toEqual({ ok: true, chosenPlatform: "truecoach" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("finite timeout + explicit body parsing", () => {
  it("maps a redeem timeout to distinct, user-visible copy (never hangs)", async () => {
    vi.useFakeTimers();
    // A fetch that never resolves; the wrapper's deadline must reject it.
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const sendMessage = vi.fn();
    const p = redeemPairingCode("123456", {
      enabled: true,
      fetch: fetchImpl,
      sendMessage,
    });
    await vi.advanceTimersByTimeAsync(15000);
    const res = await p;
    expect(res).toEqual({
      ok: false,
      error: "That took too long. Check your connection and try again.",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("passes an AbortSignal to fetch so the request is actually cancellable", async () => {
    const fetchImpl = okFetch({ access_token: "a", refresh_token: "r" });
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    await redeemPairingCode("123456", {
      enabled: true,
      fetch: fetchImpl,
      sendMessage,
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a malformed 2xx body as an unexpected response (explicit map, no silent swallow)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });
    const sendMessage = vi.fn();
    const res = await redeemPairingCode("123456", {
      enabled: true,
      fetch: fetchImpl,
      sendMessage,
    });
    expect(res).toEqual({ ok: false, error: "Unexpected pairing response." });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("treats a malformed error body as a generic failure (explicit map)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("no body");
      },
    });
    const res = await redeemPairingCode("123456", {
      enabled: true,
      fetch: fetchImpl,
      sendMessage: vi.fn(),
    });
    expect(res).toEqual({
      ok: false,
      error: "Pairing failed. Please try again.",
    });
  });
});

describe("input validation", () => {
  it.each([
    ["12345", "too short"],
    ["1234567", "too long"],
    ["12a456", "non-digit"],
    ["", "empty"],
  ])(
    "rejects a malformed code (%s — %s) before any network call",
    async (code) => {
      const fetchImpl = vi.fn();
      const res = await redeemPairingCode(code, {
        enabled: true,
        fetch: fetchImpl,
        sendMessage: vi.fn(),
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe(
        "That code isn't valid. Check the digits and try again.",
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});

describe("happy path — the production producer", () => {
  it("redeems the code and relays exactly one session_established message", async () => {
    const fetchImpl = okFetch({
      access_token: "acc",
      refresh_token: "ref",
      chosen_platform: "truecoach",
    });
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const res = await redeemPairingCode("123456", {
      enabled: true,
      fetch: fetchImpl,
      sendMessage,
    });

    expect(res).toEqual({ ok: true, chosenPlatform: "truecoach" });
    // Redeem call shape.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(REDEEM_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ code: "123456" });
    // Exactly one session_established, carrying the minted pair.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      kind: "session_established",
      accessToken: "acc",
      refreshToken: "ref",
    });
  });
});

describe("structured backend errors map to coach-facing copy", () => {
  const cases = [
    ["expired", "That code has expired. Generate a fresh one in the TGP app."],
    [
      "already_used",
      "That code was already used. Generate a fresh one in the TGP app.",
    ],
    ["invalid", "That code isn't valid. Check the digits and try again."],
    ["locked", "Too many attempts. Wait a moment, then generate a new code."],
    ["something_new", "Pairing failed. Please try again."],
  ];
  for (const [code, copy] of cases) {
    it(`maps ${code} and does not establish a session`, async () => {
      const fetchImpl = okFetch({ code }, { ok: false, status: 409 });
      const sendMessage = vi.fn();
      const res = await redeemPairingCode("123456", {
        enabled: true,
        fetch: fetchImpl,
        sendMessage,
      });
      expect(res).toEqual({ ok: false, error: copy });
      expect(sendMessage).not.toHaveBeenCalled();
    });
  }
});

describe("degenerate responses fail closed", () => {
  it("treats a 2xx response missing tokens as unexpected", async () => {
    const fetchImpl = okFetch({ chosen_platform: "truecoach" });
    const sendMessage = vi.fn();
    const res = await redeemPairingCode("123456", {
      enabled: true,
      fetch: fetchImpl,
      sendMessage,
    });
    expect(res).toEqual({ ok: false, error: "Unexpected pairing response." });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("surfaces a network failure without leaking anything", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const res = await redeemPairingCode("123456", {
      enabled: true,
      fetch: fetchImpl,
      sendMessage: vi.fn(),
    });
    expect(res).toEqual({
      ok: false,
      error: "Network error. Please try again.",
    });
  });

  it("fails closed when the worker will not acknowledge the session", async () => {
    const fetchImpl = okFetch({ access_token: "acc", refresh_token: "ref" });
    const sendMessage = vi.fn().mockResolvedValue({ ok: false });
    const res = await redeemPairingCode("123456", {
      enabled: true,
      fetch: fetchImpl,
      sendMessage,
    });
    expect(res).toEqual({
      ok: false,
      error: "Could not establish session. Please try again.",
    });
  });
});
