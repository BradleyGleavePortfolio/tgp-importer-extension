import { describe, it, expect, vi } from "vitest";
import { readSourceBearer, wireCollector } from "../content/main.js";
import { fakePageStore } from "./helpers/source-tab.js";

// Adversarial coverage of the source-token PRODUCER (content/main.js) — the seam
// that hands the crawl the coach's own source bearer. The security contract:
//   - It reads a JWT-shaped bearer from the page's OWN per-origin web storage.
//   - It answers ONLY this extension's own worker (sender.id === runtime.id); a
//     web page or a foreign extension gets NOTHING.
//   - The token is returned once via sendResponse and never stored/logged.

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb2FjaCJ9.s1g-nature_AZ09";

describe("readSourceBearer — finds a JWT-shaped bearer, site-agnostic", () => {
  it("returns the first JWT-shaped value found across the given stores", () => {
    const session = fakePageStore([
      ["noise", "not-a-jwt"],
      ["auth", JWT],
    ]);
    expect(readSourceBearer([session])).toBe(JWT);
  });

  it("scans stores in order (session before local)", () => {
    const session = fakePageStore([["s", JWT]]);
    const local = fakePageStore([["l", "aaa.bbb.ccc"]]);
    expect(readSourceBearer([session, local])).toBe(JWT);
  });

  it("falls through to a later store when earlier ones hold no JWT", () => {
    const session = fakePageStore([
      ["x", "plain"],
      ["y", "12345"],
    ]);
    const local = fakePageStore([["token", JWT]]);
    expect(readSourceBearer([session, local])).toBe(JWT);
  });

  it("returns '' when no value is JWT-shaped (never a partial/garbage token)", () => {
    const session = fakePageStore([
      ["a", "one.two"],
      ["b", "a.b.c.d"],
      ["c", ""],
    ]);
    expect(readSourceBearer([session])).toBe("");
  });

  it("ignores non-string values without throwing", () => {
    const weird = { length: 1, key: () => "k", getItem: () => null };
    expect(readSourceBearer([weird])).toBe("");
  });
});

// Drive wireCollector against a fake runtime, capturing the registered listener
// so we can invoke it with arbitrary senders/messages.
function wire(stores) {
  let listener = null;
  const runtime = {
    id: "ext-abc",
    onMessage: {
      addListener: (fn) => {
        listener = fn;
      },
    },
  };
  wireCollector(runtime, stores);
  return {
    runtime,
    invoke: (message, sender) => {
      const sendResponse = vi.fn();
      const kept = listener(message, sender, sendResponse);
      return { kept, sendResponse };
    },
  };
}

describe("wireCollector — answers only this extension's own worker", () => {
  it("returns the token to a request from THIS extension's worker", () => {
    const { runtime, invoke } = wire([fakePageStore([["auth", JWT]])]);
    const { kept, sendResponse } = invoke(
      { kind: "collect_source_token" },
      { id: runtime.id },
    );
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, token: JWT });
    expect(kept).toBe(false); // synchronous response, channel not held open
  });

  it("answers { ok: false } (never a forged token) when no JWT is present", () => {
    const { runtime, invoke } = wire([fakePageStore([["x", "plain"]])]);
    const { sendResponse } = invoke(
      { kind: "collect_source_token" },
      { id: runtime.id },
    );
    expect(sendResponse).toHaveBeenCalledWith({ ok: false });
  });

  it("IGNORES a request from a foreign extension id (no token leaks)", () => {
    const { invoke } = wire([fakePageStore([["auth", JWT]])]);
    const { sendResponse } = invoke(
      { kind: "collect_source_token" },
      { id: "some-other-ext" },
    );
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("IGNORES a request with no sender id (a page cannot address us)", () => {
    const { invoke } = wire([fakePageStore([["auth", JWT]])]);
    const { sendResponse } = invoke({ kind: "collect_source_token" }, {});
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("IGNORES an unrelated message kind from our own worker", () => {
    const { runtime, invoke } = wire([fakePageStore([["auth", JWT]])]);
    const { sendResponse } = invoke(
      { kind: "something_else" },
      { id: runtime.id },
    );
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
