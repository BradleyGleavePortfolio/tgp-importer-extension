import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installChrome, makeBgMock } from "./helpers/background-mock.js";
import { serverStatusView } from "../popup/outcome.js";
import { parseImportStatus } from "../shared/import-status.js";

// Popup half of Check status: the server record is shown in its own region,
// labelled apart from local receipts. Unknown is "not yet known" (never 0), no
// family counts are summed, there is no percent/ETA, the server terminal is the
// final state, and nothing here touches Start or its lock.
const fixture = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "test/fixtures/import-status/import-status.fixture.json",
    ),
    "utf8",
  ),
);
const INTENT = "imp-1790000000000";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const local = {
  kind: "status_snapshot",
  intent: { intentId: INTENT, platform: "truecoach", status: "ingest_partial" },
  progress: [{ entityType: "clients", sent: 7 }],
  staging: { clients: { received: 7, inserted: 7, deduped: 0 } },
  lastError: null,
  workerActive: false,
};

function known(name) {
  return {
    kind: "server_status",
    ...parseImportStatus(fixture.responses[name].body, INTENT),
  };
}

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

/**
 * @param {object} snapshot
 * @param {() => unknown} serverReply
 */
async function popup(snapshot, serverReply) {
  vi.resetModules();
  const { doc, nodes } = testDocument();
  const mock = makeBgMock();
  const sendMessage = vi.fn((request, callback = (_response) => {}) => {
    const response =
      request.kind === "request_session_state"
        ? { ok: true, hasSession: true }
        : request.kind === "request_server_status"
          ? serverReply()
          : snapshot;
    if (callback) callback(response);
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response);
  });
  mock.chrome.runtime.sendMessage = sendMessage;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
  installChrome(mock);
  await import("../popup/popup.js");
  return { mock, nodes, sendMessage };
}

function regionText(nodes) {
  const families = nodes
    .get("server-status-families")
    .children.map((row) => row.children.map((cell) => cell.textContent));
  return {
    hidden: nodes.get("server-status").hidden,
    state: nodes.get("server-status-state").textContent,
    families,
  };
}

function localReceipts(nodes) {
  return nodes
    .get("progress-list")
    .children.map((row) => row.children.map((cell) => cell.textContent));
}

describe("Check status also reads the server (popup)", () => {
  it("shows the server final state and committed counts apart from local receipts", async () => {
    const result = await popup(local, () => known("legacy_partial"));
    const receipts = localReceipts(result.nodes);
    const start = result.nodes.get("start-import");
    expect(start.disabled).toBe(true);
    expect(result.nodes.get("server-status").hidden).toBe(true);
    await result.nodes.get("check-status").click();
    expect(regionText(result.nodes)).toEqual({
      hidden: false,
      state: "Final state (TGP server): partial; some records may be missing",
      families: [["Client records", "7 committed on TGP"]],
    });
    // Local receipts and their label are unchanged and separate.
    expect(localReceipts(result.nodes)).toEqual(receipts);
    expect(result.nodes.get("status").textContent).toBe(
      "Transfer needs attention",
    );
    expect(result.nodes.get("action-feedback").textContent).toContain(
      "Local status checked",
    );
    // Start and its lock are untouched by the server read.
    expect(start.disabled).toBe(true);
    expect(start.dataset.outcomeLocked).toBe("true");
    expect(
      result.sendMessage.mock.calls.map(([request]) => request.kind),
    ).not.toContain("start_import");
  });

  it("an open server run has no final state, percent, phase or ETA", async () => {
    const result = await popup(local, () => known("server_open"));
    await result.nodes.get("check-status").click();
    const text = JSON.stringify(regionText(result.nodes));
    expect(regionText(result.nodes).state).toBe(
      "No final state recorded on TGP yet.",
    );
    expect(text).not.toMatch(
      /%|\beta\b|remaining|minute|transferring|deadline/i,
    );
  });

  it("a 404 reads 'not yet known', never 0", async () => {
    const result = await popup(local, () => ({
      kind: "server_status",
      state: "not_yet_known",
      intentId: INTENT,
    }));
    await result.nodes.get("check-status").click();
    const region = regionText(result.nodes);
    expect(region.state).toContain("Not yet known");
    expect(region.families).toEqual([]);
    expect(JSON.stringify(region)).not.toMatch(/\b0\b/);
  });

  it("a local family the server does not list is 'not yet known', never 0", async () => {
    const result = await popup(
      {
        ...local,
        staging: {
          ...local.staging,
          notes: { received: 2, inserted: 2, deduped: 0 },
        },
      },
      () => known("legacy_partial"),
    );
    await result.nodes.get("check-status").click();
    expect(regionText(result.nodes).families).toEqual([
      ["Client records", "7 committed on TGP"],
      ["Notes", "Committed on TGP: not yet known"],
    ]);
  });

  it("never sums families into an 'imported' total", async () => {
    const result = await popup(local, () => known("legacy_success"));
    await result.nodes.get("check-status").click();
    const region = regionText(result.nodes);
    expect(region.families).toEqual([
      ["Client records", "12 committed on TGP"],
      ["Notes", "3 committed on TGP"],
    ]);
    const text = JSON.stringify(region);
    expect(text).not.toContain("15");
    expect(text).not.toMatch(/imported|total/i);
    // A legacy success is a transport settlement, not a verified migration.
    expect(region.state).toBe(
      "Final state (TGP server): transfer settled; records staged, migration not verified",
    );
  });

  it.each([
    [
      "unavailable reply",
      () => ({ kind: "server_status", state: "unavailable" }),
    ],
    ["malformed reply", () => ({ ok: false })],
    ["local snapshot echoed", () => local],
    ["transport rejection", () => new Error("PRIVATE fault")],
    [
      "invalid counts",
      () => ({ ...known("legacy_partial"), counts: [{ entityType: "x" }] }),
    ],
    ["unknown status", () => ({ ...known("legacy_partial"), status: "done" })],
  ])("%s -> 'Could not check TGP', no detail", async (_name, reply) => {
    const result = await popup(local, reply);
    await result.nodes.get("check-status").click();
    const region = regionText(result.nodes);
    expect(region).toEqual({
      hidden: false,
      state: "Could not check TGP. The receipts above are unchanged.",
      families: [],
    });
    expect(JSON.stringify(region)).not.toContain("PRIVATE");
    expect(result.nodes.get("start-import").disabled).toBe(true);
  });

  it("drops a reply for another run instead of attaching it here", async () => {
    const result = await popup(local, () => ({
      ...known("legacy_partial"),
      intentId: "imp-other",
    }));
    await result.nodes.get("check-status").click();
    expect(regionText(result.nodes)).toEqual({
      hidden: true,
      state: "",
      families: [],
    });
  });

  it("clears the server record when a different run is broadcast", async () => {
    const result = await popup(local, () => known("legacy_partial"));
    await result.nodes.get("check-status").click();
    expect(result.nodes.get("server-status").hidden).toBe(false);
    await result.mock.dispatch({
      ...local,
      intent: { ...local.intent, intentId: "imp-1790000000999" },
    });
    expect(regionText(result.nodes)).toEqual({
      hidden: true,
      state: "",
      families: [],
    });
  });

  it("keeps the server record across a same-run broadcast", async () => {
    const result = await popup(local, () => known("legacy_partial"));
    await result.nodes.get("check-status").click();
    await result.mock.dispatch({ ...local });
    expect(result.nodes.get("server-status").hidden).toBe(false);
  });

  it("with no recorded run, the server read changes nothing and Start stays available", async () => {
    const empty = {
      kind: "status_snapshot",
      intent: null,
      progress: [],
      lastError: null,
    };
    const result = await popup(empty, () => ({
      kind: "server_status",
      state: "no_run",
    }));
    expect(result.nodes.get("start-import").disabled).toBe(false);
    await result.nodes.get("check-status").click();
    expect(result.nodes.get("start-import").disabled).toBe(false);
    expect(result.nodes.get("start-import").dataset.outcomeLocked).toBe(
      "false",
    );
    expect(result.nodes.get("server-status").hidden).toBe(true);
  });
});

describe("serverStatusView over every fixture example", () => {
  const message = makeBgMock().chrome.i18n.getMessage;
  const expected = {
    legacy_running: "No final state recorded on TGP yet.",
    legacy_success:
      "Final state (TGP server): transfer settled; records staged, migration not verified",
    legacy_partial:
      "Final state (TGP server): partial; some records may be missing",
    legacy_failed_zero_committed: "Final state (TGP server): failed",
    server_open: "No final state recorded on TGP yet.",
    server_timed_out: "Final state (TGP server): timed out",
    server_complete: "Final state (TGP server): complete",
  };
  it("covers exactly the fixture's 200 examples", () => {
    expect(
      Object.entries(fixture.responses)
        .filter(([, example]) => example.http_status === 200)
        .map(([name]) => name),
    ).toEqual(Object.keys(expected));
  });
  it.each(Object.entries(expected))("%s", (name, state) => {
    const view = serverStatusView(known(name), local, message);
    expect(view?.state).toBe(state);
    expect(view?.heading).toBe("TGP server record");
    // One row per server family, each its own count; nothing summed.
    const counts = fixture.responses[name].body.entity_counts;
    expect(
      view?.lines.filter((line) => line.text.endsWith("committed on TGP")),
    ).toHaveLength(counts.length);
    expect(JSON.stringify(view)).not.toMatch(/%|claimed|reason|deadline/i);
  });
  it("every server terminal has approved copy (no empty or raw state)", () => {
    for (const status of fixture.schemas.ScoutImportStatusResult.properties
      .status.enum) {
      const view = serverStatusView(
        { ...known("legacy_partial"), status },
        local,
        message,
      );
      expect(view?.state, status).toBeTruthy();
      expect(view?.state, status).not.toContain("_");
    }
  });
});
