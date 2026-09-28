import { describe, it, expect, vi, afterEach } from "vitest";
import { getJson, getBody } from "../legacy/truecoach/net.js";
import { TRUECOACH_API_BASE } from "../legacy/truecoach/api-base.js";

// Review A, A3: the legacy oracle's network path must never follow a source
// redirect off the authorized origin. The replay path already fetched with
// `redirect: "error"`; the oracle did not, so a 30x from the source could make
// it issue a credentialed request to another origin. This drives the REAL
// legacy net module (rawFetch through shared/net.js fetchWithTimeout) against
// a fetch that behaves like the platform: with `redirect: "error"` a redirect
// response rejects with a TypeError and no second request is made; without it
// the redirect is followed. Fails on 7ac1fe9.

const ORIGIN = new URL(TRUECOACH_API_BASE).origin;
const ELSEWHERE = "https://elsewhere.example/harvest";

// A fetch whose first response for `path` is a cross-origin 302. Records every
// request URL and the redirect mode it was asked to use.
function redirectingFetch(path) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url: String(url), redirect: init?.redirect });
    if (String(url) === `${TRUECOACH_API_BASE}${path}`) {
      if (init?.redirect === "error") {
        // WHATWG fetch: a redirect under redirect:"error" is a network error.
        throw new TypeError("Failed to fetch");
      }
      // redirect:"follow" (the default): the platform requests the target.
      return impl(ELSEWHERE, { ...init, redirect: init?.redirect });
    }
    if (String(url) === ELSEWHERE) {
      return new Response(JSON.stringify({ harvested: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unrouted fetch ${url}`);
  };
  return { fetch: impl, requests };
}

describe("legacy net — a source redirect is never followed", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("getJson fails closed on a cross-origin 302 and issues no request to the redirect target", async () => {
    const { fetch, requests } = redirectingFetch("/organizations");
    global.fetch = vi.fn(fetch);
    const signal = new AbortController().signal;
    await expect(
      getJson("/organizations", "src.TOKEN", signal, 0),
    ).rejects.toThrow();
    expect(requests).toEqual([
      { url: `${ORIGIN}/proxy/api/organizations`, redirect: "error" },
    ]);
    expect(requests.some((r) => r.url.startsWith(ELSEWHERE))).toBe(false);
  });

  it("getBody (the text/html goal endpoint) is held to the same rule", async () => {
    const { fetch, requests } = redirectingFetch("/clients/1/goal");
    global.fetch = vi.fn(fetch);
    const signal = new AbortController().signal;
    await expect(
      getBody("/clients/1/goal", "src.TOKEN", signal, 0),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(requests[0].redirect).toBe("error");
    expect(requests.some((r) => r.url.startsWith(ELSEWHERE))).toBe(false);
  });

  it("fixture control: the same fetch WITHOUT redirect:error does follow the redirect", async () => {
    // Proves the fixture models the platform: a follow reaches the target, so
    // the two tests above pass only because the oracle asks for redirect:error.
    const { fetch, requests } = redirectingFetch("/organizations");
    const res = await fetch(`${TRUECOACH_API_BASE}/organizations`, {
      headers: { Authorization: "Bearer x" },
    });
    expect(res.status).toBe(200);
    expect(requests.map((r) => r.url)).toContain(ELSEWHERE);
  });
});
