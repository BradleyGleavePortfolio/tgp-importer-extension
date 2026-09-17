import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";
import { fetchWithTimeout } from "../shared/net.js";
import { runReplay } from "../shared/replay/engine.js";

let makeSourceFetch;
beforeEach(async () => {
  vi.resetModules();
  installChrome(makeBgMock());
  ({ makeSourceFetch } = await import("../background.js"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const options = (signal = new AbortController().signal) => ({
  method: "GET",
  headers: {},
  signal,
  timeoutMs: 20,
});
function streamingBody() {
  let streamController;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode('{"items":['));
      },
    }),
  );
  return {
    response,
    finish: () => {
      streamController.enqueue(new TextEncoder().encode("]}"));
      streamController.close();
    },
  };
}

describe("source request deadline includes body consumption", () => {
  it("exhausts bounded retries on body timeouts using the real source adapter and engine", async () => {
    vi.useFakeTimers();
    const bodies = [];
    const signals = [];
    const fetchMock = vi.fn(async (_url, init) => {
      const body = streamingBody();
      bodies.push(body);
      signals.push(init.signal);
      return body.response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = runReplay({
      blueprint: {
        platform: "test",
        apiBase: "https://api.test",
        rateLimitMs: 0,
        budgets: { requestTimeoutMs: 20 },
        steps: [
          {
            id: "list",
            entityType: "item",
            template: "/items",
            itemsPath: ["items"],
          },
        ],
      },
      allowedOrigins: ["https://api.test"],
      fetchJson: makeSourceFetch(""),
      emit: vi.fn(),
      maxAttempts: 2,
      sleep: async () => {},
    });
    await vi.advanceTimersByTimeAsync(41);
    const result = await request;
    for (const body of bodies) body.finish();
    expect(result).toMatchObject({
      status: "failed",
      pages: 1,
      entities: 0,
      degraded: true,
      lastSkipStatus: "TimeoutError",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["timeout", "abort"])(
    "settles during a stalled real Response body: %s",
    async (mode) => {
      vi.useFakeTimers();
      const body = streamingBody();
      const caller = new AbortController();
      const observedRequest = { signal: null, error: null };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init) => {
          observedRequest.signal = init.signal;
          return body.response;
        }),
      );
      let settled = false;
      const request = makeSourceFetch("")(
        "https://api.test/items",
        options(caller.signal),
      ).then(
        () => {
          settled = true;
        },
        (err) => {
          settled = true;
          observedRequest.error = err;
        },
      );
      await vi.advanceTimersByTimeAsync(1);
      if (mode === "abort") caller.abort();
      await vi.advanceTimersByTimeAsync(30);
      const observed = {
        settled,
        name: observedRequest.error?.name,
        aborted: observedRequest.signal?.aborted,
      };
      body.finish();
      await request;
      expect(observed).toEqual({
        settled: true,
        name: mode === "abort" ? "AbortError" : "TimeoutError",
        aborted: true,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("keeps a single deadline across delayed headers and body", async () => {
    vi.useFakeTimers();
    const body = streamingBody();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(body.response), 15),
          ),
      ),
    );
    let name;
    const request = makeSourceFetch("")(
      "https://api.test/items",
      options(),
    ).then(
      () => {
        name = "resolved";
      },
      (error) => {
        name = error.name;
      },
    );
    await vi.advanceTimersByTimeAsync(21);
    const atOriginalDeadline = name;
    body.finish();
    await request;
    expect(atOriginalDeadline).toBe("TimeoutError");
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["TypeError", "AbortError"])(
    "does not mislabel body transport %s as malformed JSON",
    async (name) => {
      const error = new Error("body transport stopped");
      error.name = name;
      const stream = new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(stream)),
      );
      await expect(
        makeSourceFetch("")("https://api.test/items", options()),
      ).rejects.toBe(error);
    },
  );
  it("retains malformed JSON classification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{bad")),
    );
    await expect(
      makeSourceFetch("")("https://api.test/items", options()),
    ).rejects.toMatchObject({ name: "MalformedResponseError" });
  });
  it.each([401, 403, 429, 503])(
    "retains HTTP category and retry hints for %i",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("", { status, headers: { "Retry-After": "2" } }),
        ),
      );
      await expect(
        makeSourceFetch("")("https://api.test/items", options()),
      ).rejects.toMatchObject(
        status === 401 || status === 403
          ? { name: "AuthLostError" }
          : { name: "HttpError", status, retryAfterMs: 2000 },
      );
    },
  );
  it("does not consume raw-fetch callers' response bodies", async () => {
    const body = streamingBody();
    const result = await fetchWithTimeout(
      async () => body.response,
      "https://api.test",
    );
    expect(result).toBe(body.response);
    expect(result.bodyUsed).toBe(false);
    body.finish();
  });
  it("cleans up on a synchronous fetch throw", async () => {
    vi.useFakeTimers();
    const error = new Error("synchronous failure");
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    await expect(
      Promise.resolve().then(() =>
        fetchWithTimeout(
          () => {
            throw error;
          },
          "https://api.test",
          { signal: caller.signal },
          20,
        ),
      ),
    ).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("rejects a pre-aborted caller without starting I/O", async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchMock = vi.fn(async () => Response.json([]));
    await expect(
      fetchWithTimeout(
        fetchMock,
        "https://api.test",
        { signal: caller.signal },
        20,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("source redirect confinement", () => {
  it("configures rejection before any redirect is followed", async () => {
    const fetchMock = vi.fn(async (_url, _init) =>
      Response.json({ items: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await makeSourceFetch("secret")("https://api.test/items", options()),
    ).toEqual({ items: [] });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      credentials: "include",
      headers: { Authorization: "Bearer secret" },
    });
  });
  it("uses native fetch to refuse a redirect without reaching its target", async () => {
    let targetRequests = 0;
    const server = createServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/target" });
        res.end();
      } else {
        targetRequests += 1;
        res.end('{"items":[]}');
      }
    });
    await new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(undefined)),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("missing test port");
      await expect(
        makeSourceFetch("")(`http://127.0.0.1:${address.port}/start`, {
          ...options(),
          timeoutMs: 1000,
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(targetRequests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve(undefined))),
      );
    }
  });
});
