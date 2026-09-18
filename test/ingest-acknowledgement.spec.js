import { afterEach, describe, expect, it, vi } from "vitest";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";
import { fakePageStore, realSourceTab } from "./helpers/source-tab.js";

const base = "https://api.tgp.coach/api/scout";
const source = "https://app.truecoach.co";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function run(acknowledge, notes = []) {
  vi.resetModules();
  vi.useFakeTimers();
  const mock = makeBgMock({
    tab: {
      url: `${source}/clients`,
      sendMessage: realSourceTab("test-extension-id", [
        fakePageStore([["auth", "source.session.token"]]),
      ]),
    },
  });
  installChrome(mock);
  const settlements = [];
  const ingestSignals = [];
  const ingestBodies = [];
  const fetchMock = vi.fn(async (url, init) => {
    if (url === `${base}/ingest`) {
      ingestSignals.push(init.signal);
      ingestBodies.push(JSON.parse(init.body));
      return acknowledge(ingestBodies.at(-1), ingestBodies.length);
    }
    if (url === `${base}/ingest/complete`) {
      settlements.push(JSON.parse(init.body));
      return Response.json({});
    }
    if (url === `${base}/progress`) return new Response(null, { status: 204 });
    if (url === "https://api.tgp.coach/api/auth/extension/refresh")
      return Response.json({ access_token: "new-access" });
    if (String(url).includes("/notes")) return Response.json({ notes });
    if (String(url).startsWith(`${source}/proxy/api/clients?`))
      return Response.json({
        clients:
          new URL(url).searchParams.get("page") === "1"
            ? [{ id: "client-1" }]
            : [],
      });
    throw new Error("unexpected test request");
  });
  vi.stubGlobal("fetch", fetchMock);
  await import("../background.js");
  await mock.dispatch({
    kind: "session_established",
    accessToken: "access",
    refreshToken: "refresh",
  });
  await mock.dispatch({
    kind: "start_import",
    url: `${source}/clients`,
    tabId: 42,
  });
  await vi.advanceTimersByTimeAsync(31000);
  const snapshot = mock.sent.filter((m) => m.kind === "status_snapshot").at(-1);
  return {
    mock,
    snapshot,
    settlements,
    ingestSignals,
    ingestBodies,
    fetchMock,
  };
}

describe("wire-level ingest acknowledgements", () => {
  it.each([
    ["missing body", () => new Response(null, { status: 202 })],
    ["empty object", () => Response.json({})],
    ["null", () => Response.json(null)],
    ["array", () => Response.json([{ received: 1, deduped: 0 }])],
    ["missing deduped", () => Response.json({ received: 1 })],
    ["wrong count", () => Response.json({ received: 0, deduped: 0 })],
    ["string count", () => Response.json({ received: "1", deduped: 0 })],
    ["negative deduped", () => Response.json({ received: 1, deduped: -1 })],
    ["excess deduped", () => Response.json({ received: 1, deduped: 2 })],
    ["fractional deduped", () => Response.json({ received: 1, deduped: 0.5 })],
    ["malformed JSON", () => new Response("SYNTHETIC_PRIVATE_ACK_BODY")],
    [
      "oversized body",
      () =>
        Response.json({ received: 1, deduped: 0, detail: "x".repeat(5000) }),
    ],
  ])(
    "does not count or report a successful transfer for %s",
    async (_name, response) => {
      const result = await run(response);
      expect(result.snapshot.intent.status).toBe("ingest_failed");
      expect(result.snapshot.lastError).toBe("ingest_ack_invalid");
      expect(result.settlements).toHaveLength(1);
      expect(result.settlements[0].terminal_status).toBe("failed");
      expect(result.settlements[0].final_counts).toBeUndefined();
      expect(result.mock.notifications).toHaveLength(0);
      expect(JSON.stringify(result.mock.sent)).not.toContain(
        "SYNTHETIC_PRIVATE",
      );
    },
  );

  it.each([0, 1])(
    "accepts the existing backend contract, with deduped=%s, without claiming native completion",
    async (deduped) => {
      const result = await run(() => Response.json({ received: 1, deduped }));
      expect(result.snapshot.intent.status).toBe("ingest_succeeded");
      expect(result.settlements[0].final_counts).toEqual({
        clients: 1,
        notes: 0,
      });
      expect(result.snapshot.staging).toEqual({
        clients: { received: 1, inserted: 1 - deduped, deduped },
      });
      expect(result.mock.notifications[0].message).toContain(
        "Migration is not verified",
      );
      expect(result.mock.notifications[0].message).not.toContain("complete.");
    },
  );

  it("retains acknowledged staging counts when a later family has an invalid acknowledgement", async () => {
    const result = await run(
      (_body, ordinal) =>
        ordinal === 1
          ? Response.json({ received: 1, deduped: 0 })
          : Response.json({}),
      [{ id: "note-1" }],
    );
    expect(result.snapshot.intent.status).toBe("ingest_failed");
    expect(result.settlements[0].final_counts).toEqual({ clients: 1 });
    expect(result.snapshot.staging).toEqual({
      clients: { received: 1, inserted: 1, deduped: 0 },
    });
    expect(result.mock.notifications).toHaveLength(0);
  });

  it("bounds acknowledgement-body time and ignores late valid bytes", async () => {
    /** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
    let controller;
    const response = new Response(
      new ReadableStream({
        start(value) {
          controller = value;
        },
      }),
    );
    const result = await run(() => response);
    expect(result.snapshot.intent.status).toBe("ingest_failed");
    expect(result.ingestSignals[0].aborted).toBe(true);
    if (!controller) throw new Error("stream controller was not initialized");
    controller.enqueue(new TextEncoder().encode('{"received":1,"deduped":0}'));
    controller.close();
    await vi.advanceTimersByTimeAsync(1);
    expect(result.settlements[0].final_counts).toBeUndefined();
    expect(result.mock.notifications).toHaveLength(0);
    expect(
      result.mock.sent.filter((m) => m.intent?.status === "ingest_succeeded"),
    ).toHaveLength(0);
  });

  it("validates the retried acknowledgement after a single authorization refresh", async () => {
    const result = await run((_body, ordinal) =>
      ordinal === 1 ? new Response(null, { status: 401 }) : Response.json({}),
    );
    expect(result.ingestBodies).toHaveLength(2);
    expect(result.ingestBodies[1]).toEqual(result.ingestBodies[0]);
    expect(result.snapshot.intent.status).toBe("ingest_failed");
    expect(result.snapshot.lastError).toBe("ingest_ack_invalid");
    expect(result.settlements[0].final_counts).toBeUndefined();
  });
});
