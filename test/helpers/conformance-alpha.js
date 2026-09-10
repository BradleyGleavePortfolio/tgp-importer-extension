// NON-PRODUCTION conformance adapter for the V5 multi-adapter neutrality proof
// (PR-2b). This file lives under test/ ON PURPOSE: `conformance_alpha` is a
// synthetic, structurally-independent SECOND adapter whose only job is to prove
// the SITE-AGNOSTIC replay core (shared/replay/engine.js + blueprint.js) drives a
// shape it has never seen with ZERO core changes. It is deliberately NOT wired
// into the production resolve.js registry (the engine consumes a blueprint object
// directly) and adds NO production LOC.
//
// Structural independence from TrueCoach (the falsifiable part of the proof):
//   - TrueCoach: PAGE-paginated list + single fan-out. Here: a single un-paginated
//     list that fans out into THREE CURSOR-paginated child families.
//   - String ids in four distinct shapes (ca_* / m-* / rt_* / al_*), a nested
//     `profile` object, omitted optional fields, and deterministic poison rows.
//
// The blueprint factory returns PURE DATA (asserted by a JSON round-trip test);
// makeFixtureFetch builds a deterministic fetchJson from the recorded fixture,
// keyed by the root-relative request path plus the ?after cursor.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CONFORMANCE_ALPHA_ORIGIN = "https://conformance-alpha.test";

// Cursor descriptor shared by every child family: the next cursor rides the
// `after` query param and is located at `paging.after` in the response body.
const CURSOR = {
  style: "cursor",
  param: "after",
  nextPath: ["paging", "after"],
};

export function conformanceAlphaBlueprint() {
  return {
    platform: "conformance_alpha",
    apiBase: CONFORMANCE_ALPHA_ORIGIN,
    rateLimitMs: 0,
    headers: { Accept: "application/json" },
    steps: [
      {
        // Un-paginated coach roster; collect ids for the three fan-outs.
        id: "coaches",
        entityType: "coaches",
        template: "/v2/coaches",
        itemsPath: ["coaches"],
        idField: "id",
        collectAs: "coachIds",
      },
      {
        id: "members",
        entityType: "members",
        template: "/v2/coaches/:coach_id/members",
        forEach: "coachIds",
        itemsPath: ["members"],
        idField: "id",
        pagination: { ...CURSOR },
      },
      {
        id: "routines",
        entityType: "routines",
        template: "/v2/coaches/:coach_id/routines",
        forEach: "coachIds",
        itemsPath: ["routines"],
        idField: "id",
        pagination: { ...CURSOR },
      },
      {
        id: "activity-log",
        entityType: "activity-log",
        template: "/v2/coaches/:coach_id/activity-log",
        forEach: "coachIds",
        itemsPath: ["events"],
        idField: "id",
        pagination: { ...CURSOR },
      },
    ],
  };
}

export function loadConformanceFixture() {
  const path = fileURLToPath(
    new URL("../fixtures/conformance/conformance-alpha.json", import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

// Deterministic fetchJson over the recorded fixture. The engine builds an absolute
// URL (apiBase + template, cursor via ?after); we route on the root-relative path
// plus the ?after cursor so a page and its next page resolve to distinct bodies.
// Every request is recorded in `calls` for accounting assertions. An unrouted URL
// throws (a missing fixture entry is a test bug, never a silent empty page).
export function makeFixtureFetch(fixture) {
  const calls = [];
  async function fetchJson(url, init) {
    const u = new URL(url);
    const after = u.searchParams.get("after");
    const key = after === null ? u.pathname : `${u.pathname}?after=${after}`;
    calls.push({ url, key, method: init.method, headers: init.headers });
    const body = fixture.responses[key];
    if (body === undefined) {
      throw new Error(`conformance fixture has no response for "${key}"`);
    }
    return body;
  }
  return { fetchJson, calls };
}
