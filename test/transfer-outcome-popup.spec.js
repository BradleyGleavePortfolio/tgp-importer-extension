import { afterEach, describe, expect, it, vi } from "vitest";
import { installChrome, makeBgMock } from "./helpers/background-mock.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const failed = {
  kind: "status_snapshot",
  intent: {
    intentId: "local-test",
    platform: "truecoach",
    status: "ingest_failed",
  },
  progress: [{ entityType: "clients", sent: 1 }],
  staging: { clients: { received: 1, inserted: 1, deduped: 0 } },
  pendingTransfer: { entityType: "clients", count: 22 },
  lastError: "ingest_ack_invalid",
  workerActive: false,
};

function testDocument() {
  function node() {
    let text = "";
    const handlers = new Map();
    const children = [];
    return {
      hidden: false,
      disabled: false,
      className: "",
      dataset: {},
      children,
      get textContent() {
        return text;
      },
      set textContent(value) {
        text = value;
        children.length = 0;
      },
      appendChild(child) {
        children.push(child);
      },
      addEventListener(type, handler) {
        handlers.set(type, handler);
      },
      click() {
        return handlers.get("click")?.();
      },
    };
  }
  const nodes = new Map();
  const doc = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node());
      return nodes.get(id);
    },
    createElement: node,
    querySelectorAll: () => [],
  };
  return { doc, nodes };
}

/** @param {object} [snapshot] */
async function popup(snapshot = failed) {
  vi.resetModules();
  const { doc, nodes } = testDocument();
  const mock = makeBgMock();
  const copied = [];
  const writeText = vi.fn(async (text) => {
    copied.push(text);
  });
  const sendMessage = vi.fn((request, callback = (_response) => {}) => {
    const response =
      request.kind === "request_session_state"
        ? { ok: true, hasSession: true }
        : snapshot;
    if (callback) callback(response);
    return Promise.resolve(response);
  });
  mock.chrome.runtime.sendMessage = sendMessage;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  installChrome(mock);
  await import("../popup/popup.js");
  return { mock, nodes, sendMessage, copied, writeText };
}

describe("actual popup outcome flow", () => {
  it("puts the meaningful result ahead of the technical transfer details", async () => {
    const { nodes } = await popup();
    expect(nodes.get("status").textContent).toBe("Transfer needs attention");
    const family = nodes.get("progress-list").children[0];
    expect(family.children.map((child) => child.textContent)).toEqual([
      "Client records",
      "1 confirmed received: 1 newly staged, 0 with no new row.",
      "22 unconfirmed. They may already have reached TGP; do not retry blindly.",
    ]);
    expect(nodes.get("outcome-issue").textContent).toContain(
      "valid transfer receipt",
    );
    expect(nodes.get("outcome-native").textContent).toContain(
      "not verified clients",
    );
    expect(nodes.get("outcome-coverage").textContent).toContain("unknown");
    expect(nodes.get("error").hidden).toBe(true);
  });

  it.each([
    "ingest_started",
    "ingest_partial",
    "ingest_failed",
    "ingest_succeeded",
    "ingest_empty",
  ])("locks a new popup Start over the existing %s result", async (status) => {
    const result = await popup({
      ...failed,
      intent: { ...failed.intent, status },
    });
    result.sendMessage.mockClear();
    const button = result.nodes.get("start-import");
    expect(button.disabled).toBe(true);
    button.click();
    await Promise.resolve();
    expect(result.sendMessage).not.toHaveBeenCalled();
    expect(result.nodes.get("outcome-guidance").textContent).toContain(
      "before another transfer",
    );
  });

  it("still offers Start when no run has been recorded", async () => {
    const { nodes } = await popup({
      kind: "status_snapshot",
      intent: null,
      progress: [],
      lastError: null,
    });
    expect(nodes.get("start-import").disabled).toBe(false);
    expect(nodes.get("detail").hidden).toBe(true);
    expect(nodes.get("empty").hidden).toBe(false);
  });

  it("Check status refreshes the same result without emitting a Start", async () => {
    const result = await popup();
    result.sendMessage.mockClear();
    await result.nodes.get("check-status").click();
    expect(result.sendMessage).toHaveBeenCalledExactlyOnceWith({
      kind: "request_status",
    });
    expect(result.nodes.get("action-feedback").textContent).toContain(
      "Local status checked",
    );
    expect(result.nodes.get("start-import").disabled).toBe(true);
    expect(result.nodes.get("progress-list").children).toHaveLength(1);
  });

  it.each(["reject", "malformed"])(
    "preserves the displayed result when status %s",
    async (mode) => {
      const result = await popup();
      if (mode === "reject")
        result.sendMessage.mockRejectedValue(new Error("private fault"));
      else result.sendMessage.mockResolvedValue({ ok: false });
      await result.nodes.get("check-status").click();
      expect(result.nodes.get("status").textContent).toBe(
        "Transfer needs attention",
      );
      expect(
        result.nodes.get("progress-list").children[0].children[2].textContent,
      ).toContain("22 unconfirmed");
      expect(result.nodes.get("action-feedback").textContent).toContain(
        "unchanged",
      );
      expect(result.nodes.get("action-feedback").textContent).not.toContain(
        "private",
      );
    },
  );

  it("Copy summary is a user-triggered local action and copies only bounded evidence", async () => {
    const result = await popup({
      ...failed,
      intent: {
        ...failed.intent,
        intentId: "PRIVATE_ID",
        platform: "PRIVATE_PLATFORM",
      },
      lastError: "ingest_ack_invalid PRIVATE_ERROR",
    });
    expect(result.writeText).not.toHaveBeenCalled();
    await result.nodes.get("copy-summary").click();
    expect(result.copied).toHaveLength(1);
    expect(result.copied[0]).toContain("22 unconfirmed");
    expect(result.copied[0]).toContain("Missing-record count is unknown");
    expect(result.copied[0]).not.toContain("PRIVATE");
    expect(result.nodes.get("action-feedback").textContent).toContain(
      "Summary copied",
    );
  });

  it("uses the latest received result when copying, not a captured old closure", async () => {
    const result = await popup();
    await result.mock.dispatch({
      ...failed,
      staging: { clients: { received: 9, inserted: 8, deduped: 1 } },
      pendingTransfer: { entityType: "notes", count: 7 },
    });
    await result.nodes.get("copy-summary").click();
    expect(result.copied[0]).toContain("9 confirmed received");
    expect(result.copied[0]).toContain("7 unconfirmed");
    expect(result.copied[0]).not.toContain("22 unconfirmed");
  });

  it("clipboard failure gives a visible manual-copy fallback and keeps counts intact", async () => {
    const result = await popup();
    result.writeText.mockRejectedValue(new Error("permission PRIVATE_DETAILS"));
    await result.nodes.get("copy-summary").click();
    expect(result.nodes.get("action-feedback").textContent).toContain(
      "select and copy",
    );
    expect(result.nodes.get("action-feedback").textContent).not.toContain(
      "PRIVATE",
    );
    expect(
      result.nodes.get("progress-list").children[0].children[2].textContent,
    ).toContain("22 unconfirmed");
  });

  it("shows interrupted rather than running on a cold-worker result", async () => {
    const result = await popup({
      ...failed,
      intent: { ...failed.intent, status: "ingest_started" },
    });
    expect(result.nodes.get("status").textContent).toBe(
      "Transfer status needs checking",
    );
    expect(
      result.nodes.get("progress-list").children[0].children[2].textContent,
    ).toContain("22 unconfirmed");
  });

  it("shows awaiting confirmation while the current worker is executing", async () => {
    const result = await popup({
      ...failed,
      intent: { ...failed.intent, status: "ingest_started" },
      workerActive: true,
      lastError: null,
    });
    expect(result.nodes.get("status").textContent).toBe(
      "Bringing records across",
    );
    expect(
      result.nodes.get("progress-list").children[0].children[2].textContent,
    ).toBe("22 awaiting confirmation.");
    expect(result.nodes.get("start-import").disabled).toBe(true);
  });

  it("an in-flight Start acknowledgement cannot unlock a newly rendered recorded run", async () => {
    const result = await popup({
      kind: "status_snapshot",
      intent: null,
      progress: [],
    });
    /** @type {(value: object) => void} */
    let reply = (_value) => {
      throw new Error("Start request was not sent");
    };
    result.mock.chrome.tabs.query = vi.fn(async () => [
      { id: 1, url: "https://app.truecoach.co/clients" },
    ]);
    result.sendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    const button = result.nodes.get("start-import");
    button.click();
    await Promise.resolve();
    await result.mock.dispatch(failed);
    reply({ ok: true });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(button.disabled).toBe(true);
    expect(result.nodes.get("status").textContent).toBe(
      "Transfer needs attention",
    );
  });
});
