import { afterEach, describe, it, expect, vi } from "vitest";
import * as originalResolver from "../shared/replay/resolve.js";
import { runReplay } from "../shared/replay/engine.js";
import { makeBgMock, installChrome } from "./helpers/background-mock.js";
import { readFileSync } from "node:fs";

const origin = "https://app.truecoach.co";
const cases = [
  {
    name: "cursor cycle",
    pagination: { style: "cursor", param: "cursor", nextPath: ["next"] },
    reason: "pagination_cycle",
    detail: "source pagination repeated a page",
    pages: 2,
    budgets: {},
  },
  {
    name: "safe integer ceiling",
    pagination: { style: "page", start: Number.MAX_SAFE_INTEGER },
    reason: "page_ceiling",
    detail: "pagination reached the safe page-number ceiling",
    pages: 1,
    budgets: {},
  },
  {
    name: "configured budget",
    pagination: { style: "page" },
    reason: "budget",
    detail: "reached the import safety limit",
    pages: 1,
    budgets: { maxPages: 1 },
  },
];

function blueprint(pagination, budgets) {
  return {
    platform: "truecoach",
    apiBase: origin,
    rateLimitMs: 0,
    budgets,
    steps: [
      {
        id: "clients",
        entityType: "client",
        template: "/clients",
        itemsPath: ["items"],
        pagination,
      },
    ],
  };
}
const body = {
  items: [{ id: "one", private: "private-body" }],
  next: "private-cursor",
};

const warningCases = [
  ...cases.map((scenario) => ({ ...scenario, responses: undefined })),
  {
    name: "malformed selected array after a saved batch",
    pagination: { style: "page" },
    budgets: {},
    detail: "some pages were skipped",
    pages: 2,
    responses: [body, { items: { private: "private-body" } }],
  },
  {
    name: "malformed cursor after a saved batch",
    pagination: { style: "cursor", nextPath: ["next"] },
    budgets: {},
    detail: "some pages were skipped",
    pages: 1,
    responses: [{ ...body, next: { private: "private-cursor" } }],
  },
];

afterEach(() => {
  vi.doUnmock("../shared/replay/resolve.js");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("truncated replay preserves reason-specific bounded diagnostics", () => {
  it.each(cases)(
    "reports $name without response data",
    async ({ pagination, budgets, reason, pages }) => {
      const fetchJson = vi.fn(async () => body);
      const result = await runReplay({
        blueprint: blueprint(pagination, budgets),
        allowedOrigins: [origin],
        fetchJson,
        emit: async () => {},
      });
      expect(result).toMatchObject({
        status: "partial",
        truncated: true,
        degraded: false,
        entities: 1,
        pages,
        truncationReasons: [reason],
      });
      expect(fetchJson).toHaveBeenCalledTimes(pages);
      expect(JSON.stringify(result)).not.toMatch(/private-body|private-cursor/);
    },
  );

  it.each(warningCases)(
    "settles and broadcasts accurate $name copy through the real engine",
    async ({ pagination, budgets, detail, pages, ...scenario }) => {
      vi.resetModules();
      vi.doMock("../shared/replay/resolve.js", () => ({
        ...originalResolver,
        resolveBlueprint: () => blueprint(pagination, budgets),
      }));
      const mock = makeBgMock({
        session: new Map([["tgp_refresh_token", "test-refresh"]]),
        tab: { url: `${origin}/clients`, token: "test-source-token" },
      });
      installChrome(mock);
      const completeBodies = [];
      const sourceCalls = [];
      const fetchMock = vi.fn(async (url, init) => {
        const value = String(url);
        if (value === "https://api.tgp.coach/api/auth/extension/refresh") {
          return Response.json({ access_token: "test-access" });
        }
        if (value.startsWith(`${origin}/clients`)) {
          sourceCalls.push(value);
          return Response.json(
            scenario.responses?.[sourceCalls.length - 1] ?? body,
          );
        }
        if (value === "https://api.tgp.coach/api/scout/ingest/complete") {
          completeBodies.push(JSON.parse(init.body));
          return Response.json({});
        }
        if (
          value === "https://api.tgp.coach/api/scout/ingest" ||
          value === "https://api.tgp.coach/api/scout/progress"
        ) {
          return Response.json({});
        }
        throw new Error("unexpected test request");
      });
      vi.stubGlobal("fetch", fetchMock);
      await import("../background.js");
      await mock.dispatch({
        kind: "start_import",
        url: `${origin}/clients`,
        tabId: 42,
      });
      await vi.waitFor(
        () => {
          const snapshot = mock.sent
            .filter((m) => m.kind === "status_snapshot")
            .at(-1);
          expect(snapshot?.intent?.status).toBe("ingest_partial");
        },
        { timeout: 3000 },
      );
      const expected = `partial import (${detail}) — 1 record(s) received. Migration is not complete. Contact TGP support with this warning before retrying.`;
      const snapshot = mock.sent
        .filter((m) => m.kind === "status_snapshot")
        .at(-1);
      expect(snapshot.lastError).toBe(expected);
      expect(completeBodies).toEqual([
        expect.objectContaining({
          terminal_status: "partial",
          final_counts: { client: 1 },
          error_summary: expected,
        }),
      ]);
      expect(sourceCalls).toHaveLength(pages);
      expect(JSON.stringify(completeBodies)).not.toMatch(
        /private-body|private-cursor|test-source-token/,
      );
    },
  );
});

describe("partial-warning message catalog", () => {
  it("declares English as Chrome's supported locale fallback with real substitutions", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
    );
    expect(manifest.default_locale).toBe("en");
    const { chrome } = makeBgMock();
    const reason = chrome.i18n.getMessage("replay_partial_incomplete");
    expect(reason).toBe("incomplete");
    const message = chrome.i18n.getMessage("replay_partial_summary", [
      reason,
      "7",
    ]);
    expect(message).toContain("7 record(s) received");
    expect(message).toContain("Migration is not complete.");
    expect(message).toContain(
      "Contact TGP support with this warning before retrying.",
    );
    expect(message).not.toMatch(/\$(REASONS|COUNT)\$/);
    expect(chrome.i18n.getMessage("not_a_supported_key")).toBe("");
  });
});
