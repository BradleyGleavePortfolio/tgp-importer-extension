import { describe, expect, it } from "vitest";
import { outcomeView } from "../popup/outcome.js";
import { makeBgMock } from "./helpers/background-mock.js";

const message = makeBgMock().chrome.i18n.getMessage;
const failed = {
  intent: { status: "ingest_failed" },
  staging: { clients: { received: 12, inserted: 10, deduped: 2 } },
  pendingTransfer: { entityType: "clients", count: 22 },
  lastError: "ingest_ack_invalid",
};

describe("local transfer evidence projection", () => {
  it("separates 12 confirmed receipts from 22 unconfirmed client records", () => {
    const view = outcomeView(failed, message);
    expect(view.title).toBe("Transfer needs attention");
    expect(view.lines).toEqual([
      {
        label: "Client records",
        receipt: "12 confirmed received: 10 newly staged, 2 with no new row.",
        unconfirmed:
          "22 unconfirmed. They may already have reached TGP; do not retry blindly.",
      },
    ]);
    expect(view.issue).toContain("valid transfer receipt");
    expect(view.coverage).toContain("Missing-record count is unknown");
    expect(view.native).toContain("not verified clients or history");
    expect(view.summary).not.toMatch(
      /22 (lost|failed|recovered|missing) clients/,
    );
    expect(view.summary).not.toContain("34");
  });

  it("labels a live outstanding batch as awaiting confirmation, not failed", () => {
    const view = outcomeView(
      {
        ...failed,
        intent: { status: "ingest_started" },
        workerActive: true,
        lastError: null,
      },
      message,
    );
    expect(view.title).toBe("Bringing records across");
    expect(view.lines[0].unconfirmed).toBe("22 awaiting confirmation.");
    expect(view.guidance).toContain("latest recorded progress");
    expect(view.issue).toBe("");
  });

  it.each([undefined, false, null, "true"])(
    "does not pretend a persisted running state proves a live worker (%s)",
    (workerActive) => {
      const view = outcomeView(
        {
          ...failed,
          workerActive,
          intent: { status: "ingest_started" },
        },
        message,
      );
      expect(view.title).toBe("Transfer status needs checking");
      expect(view.lines[0].unconfirmed).toContain("22 unconfirmed");
    },
  );

  it.each([
    "ingest_succeeded",
    "ingest_partial",
    "ingest_failed",
    "ingest_empty",
  ])(
    "never upgrades %s to verified migration or treats unknown coverage as zero",
    (status) => {
      const view = outcomeView(
        {
          ...failed,
          intent: { status },
          pendingTransfer: null,
        },
        message,
      );
      expect(view.native).toContain("not verified");
      expect(view.coverage).toContain("unknown");
      expect(view.summary).not.toMatch(
        /100%|all records|ready to use in TGP\.$/,
      );
      expect(view.guidance).toContain("Automatic recovery is not available");
      expect(view.lines[0].unconfirmed).toBe("");
    },
  );

  it("old snapshots do not manufacture receipts from progress totals", () => {
    const view = outcomeView(
      {
        intent: { status: "ingest_succeeded" },
        progress: [{ entityType: "clients", sent: 123, total: 123 }],
      },
      message,
    );
    expect(view.lines).toEqual([]);
    expect(view.noReceipt).toContain("No detailed transfer receipts");
    expect(view.summary).not.toContain("123");
    expect(view.summary).toContain("does not prove that nothing was written");
  });

  it.each([
    { received: -1, inserted: -1, deduped: 0 },
    { received: 2, inserted: 1, deduped: 0 },
    { received: 1.5, inserted: 1.5, deduped: 0 },
    { received: "2", inserted: 2, deduped: 0 },
    { received: Infinity, inserted: Infinity, deduped: 0 },
    { received: 2 ** 53, inserted: 2 ** 53, deduped: 0 },
    null,
    {},
  ])(
    "rejects unusable receipt evidence instead of displaying false counts: %j",
    (receipt) => {
      const view = outcomeView(
        {
          intent: { status: "ingest_failed" },
          staging: { clients: receipt },
        },
        message,
      );
      expect(view.lines).toHaveLength(0);
      expect(view.noReceipt).not.toBe("");
    },
  );

  it.each([-1, 0, 1.5, "22", Infinity, 2 ** 53, undefined])(
    "never invents an unconfirmed count from invalid pending input (%s)",
    (value) => {
      const view = outcomeView(
        {
          ...failed,
          pendingTransfer: { entityType: "clients", count: value },
        },
        message,
      );
      expect(view.lines[0].unconfirmed).toBe("");
    },
  );

  it("can show a first failed batch without implying any acknowledged receipts", () => {
    const view = outcomeView(
      {
        intent: { status: "ingest_failed" },
        pendingTransfer: { entityType: "clients", count: 22 },
      },
      message,
    );
    expect(view.lines[0].receipt).toContain("0 confirmed received");
    expect(view.lines[0].unconfirmed).toContain("22 unconfirmed");
    expect(view.summary).not.toContain("nothing was written");
  });

  it("keeps a later failed family distinct from earlier acknowledged clients", () => {
    const view = outcomeView(
      {
        ...failed,
        pendingTransfer: { entityType: "notes", count: 22 },
      },
      message,
    );
    expect(view.lines.map((row) => row.label)).toEqual([
      "Client records",
      "Notes",
    ]);
    expect(view.lines[0].unconfirmed).toBe("");
    expect(view.lines[1].unconfirmed).toContain("22");
    expect(view.lines[1].receipt).toContain("0 confirmed received");
  });

  it("copies no raw errors, identity fields, source metadata or URLs", () => {
    const marker = "SYNTHETIC_PRIVATE";
    const view = outcomeView(
      {
        ...failed,
        intent: { status: "ingest_failed", intentId: marker, platform: marker },
        staging: {
          [marker]: { received: 1, inserted: 1, deduped: 0, payload: marker },
        },
        pendingTransfer: { entityType: marker, count: 22, sourceId: marker },
        lastError: `https://example.test/${marker}?token=${marker}`,
      },
      message,
    );
    expect(view.summary).not.toContain(marker);
    expect(view.summary).not.toContain("https://");
    expect(view.lines[0].label).toBe("Records");
    expect(view.issue).toContain("stopped");
  });

  it.each([
    ["source sign-in required", "source sign-in expired"],
    ["ingest_ack_invalid", "valid transfer receipt"],
    ["complete_timeout", "final status could not be confirmed"],
    ["complete 500", "final status could not be confirmed"],
    [
      "partial import (some pages were skipped)",
      "source pages could not be read",
    ],
    ["TypeError arbitrary private detail", "stopped"],
  ])(
    "translates %s into a bounded actionable reason",
    (lastError, expected) => {
      const view = outcomeView({ ...failed, lastError }, message);
      expect(view.issue).toContain(expected);
      expect(view.summary).not.toContain("arbitrary private detail");
    },
  );

  it("does not mutate snapshot evidence while deriving a result", () => {
    const original = structuredClone(failed);
    outcomeView(failed, message);
    expect(failed).toEqual(original);
  });

  it("handles prototype-like entity names as ordinary own data", () => {
    const view = outcomeView(
      {
        ...failed,
        staging: JSON.parse(
          '{"__proto__":{"received":3,"inserted":3,"deduped":0}}',
        ),
        pendingTransfer: { entityType: "__proto__", count: 22 },
      },
      message,
    );
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].receipt).toContain("3 confirmed");
    expect(view.lines[0].unconfirmed).toContain("22");
    expect(Object.prototype).not.toHaveProperty("received");
  });
});
