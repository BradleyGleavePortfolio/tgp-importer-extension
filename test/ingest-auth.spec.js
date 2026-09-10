import { describe, it, expect, vi } from "vitest";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";

// Router-level coverage of the start_ingest AUTH gate in background.js: before
// any extractor runs, the worker must have (or be able to mint) a TGP access
// token. With no session — or a refresh that fails — it must fail closed by
// broadcasting auth_required and must NOT start a crawl. Unsupported sites are
// rejected up front. The extractor run itself is covered elsewhere; these tests
// pin the pre-run guards, which are the security-relevant branches.

const REFRESH_KEY = "tgp_refresh_token";

// @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
async function load({ session } = {}) {
  vi.resetModules();
  const mock = makeBgMock({ session });
  installChrome(mock);
  global.fetch = vi.fn();
  const bg = await import("../background.js");
  return { mock, bg };
}

// Flush the async handler chain (getAccessToken + broadcasts run after dispatch
// returns its synchronous ack).
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function snapshots(mock) {
  return mock.sent.filter((m) => m && m.kind === "status_snapshot");
}
function authRequired(mock) {
  return mock.sent.filter((m) => m && m.kind === "auth_required");
}

describe("start_ingest — unsupported site", () => {
  it("rejects a non-TrueCoach URL without touching auth", async () => {
    const { mock } = await load();
    const ack = await mock.dispatch({
      kind: "start_ingest",
      url: "https://example.com/x",
    });
    expect(ack).toEqual({ ok: true });
    await flush();
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toContain("unsupported site");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(authRequired(mock)).toHaveLength(0);
  });
});

describe("start_ingest — no session fails closed", () => {
  it("broadcasts auth_required and starts no crawl when there is no token", async () => {
    const { mock } = await load();
    const ack = await mock.dispatch({
      kind: "start_ingest",
      url: "https://app.truecoach.co/clients",
    });
    expect(ack).toEqual({ ok: true });
    await flush();
    expect(authRequired(mock)).toHaveLength(1);
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toBe("login required to import");
    // No refresh token existed, so no network refresh was even attempted.
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("start_ingest — refresh failure fails closed", () => {
  it("broadcasts auth_required when the only refresh token is rejected", async () => {
    const { mock } = await load({
      session: new Map([[REFRESH_KEY, "stale-refresh"]]),
    });
    // @ts-expect-error -- legacy test intentionally exercises a partial runtime mock shape.
    global.fetch.mockResolvedValue({ ok: false, status: 401 });
    const ack = await mock.dispatch({
      kind: "start_ingest",
      url: "https://app.truecoach.co/clients",
    });
    expect(ack).toEqual({ ok: true });
    await flush();
    // The refresh endpoint was tried exactly once and failed.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(authRequired(mock)).toHaveLength(1);
    const last = snapshots(mock).at(-1);
    expect(last.lastError).toBe("login required to import");
  });

  it("recognises a Tier-1 brand subdomain as TrueCoach (auth gate still applies)", async () => {
    const { mock } = await load();
    const ack = await mock.dispatch({
      kind: "start_ingest",
      url: "https://brand.truecoach.co/clients",
    });
    expect(ack).toEqual({ ok: true });
    await flush();
    // Recognised as truecoach (not "unsupported"), so it reaches the auth gate.
    expect(authRequired(mock)).toHaveLength(1);
    expect(snapshots(mock).at(-1).lastError).toBe("login required to import");
  });
});
