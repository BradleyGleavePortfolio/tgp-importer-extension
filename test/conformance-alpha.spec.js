import { describe, it, expect } from "vitest";
import { runReplay } from "../shared/replay/engine.js";
import { normalizeBlueprint } from "../shared/replay/blueprint.js";
import {
  conformanceAlphaBlueprint,
  loadConformanceFixture,
  makeFixtureFetch,
  CONFORMANCE_ALPHA_ORIGIN,
} from "./helpers/conformance-alpha.js";

// V5 multi-adapter neutrality proof (PR-2b). `conformance_alpha` is a synthetic
// SECOND adapter, structurally independent from TrueCoach, driven end-to-end
// through the UNMODIFIED site-agnostic core (runReplay + normalizeBlueprint,
// imported above from shared/replay/*). The pass gate: the core reproduces an
// INDEPENDENTLY hand-authored golden (fixture.expect_records) for a shape it has
// never seen, with ZERO changes to any production file. The git diff for this PR
// touching nothing under shared/ or extractors/ is the other half of that proof.

const FIXTURE = loadConformanceFixture();
const GOLDEN = FIXTURE.expect_records;
const FIXED_MS = Date.parse("2026-07-02T00:00:00.000Z");
const FIXED_ISO = "2026-07-02T00:00:00.000Z";

function get(bp, id) {
  return bp.steps.find((s) => s.id === id);
}

// Drive the real engine over the fixture; return emitted batches grouped by
// entity_type plus the run result and the recorded source calls.
async function replay() {
  const emittedByType = {};
  const { fetchJson, calls } = makeFixtureFetch(FIXTURE);
  const result = await runReplay({
    blueprint: conformanceAlphaBlueprint(),
    allowedOrigins: FIXTURE.allowedOrigins,
    fetchJson,
    emit: async (entityType, batch) => {
      (emittedByType[entityType] ??= []).push(...batch);
    },
    now: () => FIXED_MS,
    sleep: async () => {},
  });
  return { result, emittedByType, calls };
}

describe("conformanceAlphaBlueprint — data-only, structurally independent from TrueCoach", () => {
  it("is pure data: round-trips through JSON losslessly (no functions in the tree)", () => {
    const bp = conformanceAlphaBlueprint();
    expect(JSON.parse(JSON.stringify(bp))).toEqual(bp);
  });

  it("declares the non-production platform id and reserved-TLD apiBase", () => {
    const bp = conformanceAlphaBlueprint();
    expect(bp.platform).toBe("conformance_alpha");
    expect(new URL(bp.apiBase).origin).toBe(CONFORMANCE_ALPHA_ORIGIN);
  });

  it("lists coaches un-paginated and collects their ids for fan-out", () => {
    const coaches = get(conformanceAlphaBlueprint(), "coaches");
    expect(coaches.template).toBe("/v2/coaches");
    expect(coaches.itemsPath).toEqual(["coaches"]);
    expect(coaches.collectAs).toBe("coachIds");
    expect(coaches.pagination).toBeUndefined();
  });

  it("fans out into THREE cursor-paginated child families over the collected ids", () => {
    const bp = conformanceAlphaBlueprint();
    for (const [id, itemsPath] of [
      ["members", ["members"]],
      ["routines", ["routines"]],
      ["activity-log", ["events"]],
    ]) {
      const step = get(bp, id);
      expect(step.forEach).toBe("coachIds");
      expect(step.template).toBe(`/v2/coaches/:coach_id/${id}`);
      expect(step.itemsPath).toEqual(itemsPath);
      expect(step.pagination).toEqual({
        style: "cursor",
        param: "after",
        nextPath: ["paging", "after"],
      });
    }
  });

  it("is topologically UNLIKE TrueCoach: no PAGE pagination anywhere (cursor only)", () => {
    for (const step of conformanceAlphaBlueprint().steps) {
      expect(step.pagination?.style ?? null).not.toBe("page");
    }
  });

  it("uses only safe methods and root-relative templates", () => {
    for (const step of conformanceAlphaBlueprint().steps) {
      expect(["GET", "HEAD"]).toContain(step.method ?? "GET");
      expect(step.template.startsWith("/")).toBe(true);
      expect(step.template.startsWith("//")).toBe(false);
    }
  });
});

describe("conformanceAlphaBlueprint — normalizes under the injected allowlist (SSRF confinement)", () => {
  it("passes normalization when the injected origin covers apiBase", () => {
    const norm = normalizeBlueprint(conformanceAlphaBlueprint(), {
      allowedOrigins: FIXTURE.allowedOrigins,
    });
    expect(norm.platform).toBe("conformance_alpha");
    expect(norm.steps).toHaveLength(4);
    expect(norm.steps.filter((s) => s.forEach === "coachIds")).toHaveLength(3);
  });

  it("fails closed with no allowlist", () => {
    expect(() => normalizeBlueprint(conformanceAlphaBlueprint(), {})).toThrow(
      /allowedOrigins/,
    );
  });

  it("fails closed when the injected origin is an unrelated site", () => {
    expect(() =>
      normalizeBlueprint(conformanceAlphaBlueprint(), {
        allowedOrigins: ["https://app.truecoach.co"],
      }),
    ).toThrow(/allowed-origins/);
  });
});

describe("conformance_alpha e2e — the site-agnostic core reproduces the golden verbatim", () => {
  it("completes a whole walk and emits exactly the independently-authored expect_records", async () => {
    const { result, emittedByType } = await replay();

    // A clean, untruncated walk: poison ROWS are tolerated (they never mark the
    // page skipped), so the terminal status is an honest "complete".
    expect(result.status).toBe("complete");
    expect(result.degraded).toBe(false);
    expect(result.truncated).toBe(false);

    // Every family matches the hand-authored golden EXACTLY, in order — this is
    // the neutrality pass gate.
    for (const family of ["coaches", "members", "routines", "activity-log"]) {
      const got = (emittedByType[family] ?? []).map((e) => ({
        sourceId: e.sourceId,
        payload: e.payload,
      }));
      expect(got).toEqual(GOLDEN[family]);
    }

    // Exact total across families (2 coaches + 6 members + 3 routines + 3 activity).
    expect(result.entities).toBe(14);
  });

  it("stamps every entity with the LOCKED envelope, the platform, and a deterministic capturedAt", async () => {
    const { emittedByType } = await replay();
    const all = Object.values(emittedByType).flat();
    expect(all).toHaveLength(14);
    for (const e of all) {
      expect(Object.keys(e).sort()).toEqual([
        "capturedAt",
        "payload",
        "sourceId",
        "sourcePlatform",
      ]);
      expect(e.sourcePlatform).toBe("conformance_alpha");
      expect(e.capturedAt).toBe(FIXED_ISO);
    }
  });

  it("tolerates poison rows deterministically (missing id + non-object → synthetic ids)", async () => {
    const { emittedByType } = await replay();
    const memberIds = emittedByType.members.map((e) => e.sourceId);
    // The no-id object and the non-object element get URL-free synthetic ids,
    // bound to (step, coach context, page, index) — never a request token.
    expect(memberIds).toContain("members#ca_1001#1#1");
    expect(memberIds).toContain("members#ca_1001#1#2");
    const ghost = emittedByType.members.find(
      (e) => e.sourceId === "members#ca_1001#1#2",
    );
    expect(ghost.payload).toBe("not-an-object-poison");
  });

  it("autonomously fans out and cursor-paginates per coach (exact source-request accounting)", async () => {
    const { calls } = await replay();
    const keys = calls.map((c) => c.key);
    // 1 coaches + (2+1) members + (1+1) routines + (2+1) activity-log = 9 requests.
    expect(keys).toEqual([
      "/v2/coaches",
      "/v2/coaches/ca_1001/members",
      "/v2/coaches/ca_1001/members?after=mc1",
      "/v2/coaches/ca_1002/members",
      "/v2/coaches/ca_1001/routines",
      "/v2/coaches/ca_1002/routines",
      "/v2/coaches/ca_1001/activity-log",
      "/v2/coaches/ca_1001/activity-log?after=ac1",
      "/v2/coaches/ca_1002/activity-log",
    ]);
    // The blueprint's Accept header is forwarded verbatim on every source call.
    for (const c of calls) {
      expect(c.headers.Accept).toBe("application/json");
    }
  });

  it("is idempotent within a run: no (entity_type, sourceId) pair is emitted twice", async () => {
    const { emittedByType } = await replay();
    for (const [family, batch] of Object.entries(emittedByType)) {
      const ids = batch.map((e) => e.sourceId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(family).toBeTruthy();
    }
  });
});
