import { afterEach, describe, expect, it, vi } from "vitest";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(snapshot) {
  vi.resetModules();
  function node() {
    return {
      textContent: "",
      className: "",
      hidden: false,
      children: [],
      dataset: {},
      appendChild(child) {
        this.children.push(child);
      },
      addEventListener: vi.fn(),
    };
  }
  const nodes = new Map();
  const doc = {
    getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, node());
      return nodes.get(id);
    },
    createElement: node,
    querySelectorAll: () => [],
  };
  vi.stubGlobal("document", doc);
  const mock = makeBgMock();
  installChrome(mock);
  await import("../popup/popup.js");
  await mock.dispatch({ kind: "status_snapshot", ...snapshot });
  return nodes;
}

describe("staging is not native migration completion", () => {
  it("renders the real localized staging status and separates no-op counts", async () => {
    const nodes = await render({
      intent: {
        intentId: "test",
        platform: "truecoach",
        status: "ingest_succeeded",
      },
      progress: [{ entityType: "clients", sent: 12 }],
      staging: { clients: { received: 12, inserted: 10, deduped: 2 } },
    });
    expect(nodes.get("status").textContent).toBe(
      "Transfer staged. Migration is not verified.",
    );
    expect(nodes.get("progress-list").children[0].children[1].textContent).toBe(
      "12 confirmed received: 10 newly staged, 2 with no new row.",
    );
    expect(nodes.get("error").hidden).toBe(true);
  });

  it("keeps older snapshots readable without inventing staging evidence", async () => {
    const nodes = await render({
      intent: {
        intentId: "test",
        platform: "truecoach",
        status: "ingest_started",
      },
      progress: [{ entityType: "clients", sent: 4, total: 8 }],
    });
    expect(nodes.get("status").textContent).toBe(
      "Transfer status needs checking",
    );
    expect(nodes.get("progress-list").children[0].children[1].textContent).toBe(
      "4 / 8",
    );
  });
});
