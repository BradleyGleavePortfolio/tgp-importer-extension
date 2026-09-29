import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { truecoachBlueprint } from "../extractors/truecoach/blueprint.js";
import { buildStructureDigest, canonicalJson } from "../shared/learn/digest.js";
import {
  compileLearnedBlueprint,
  learnedRegistration,
  LEARNED_RATE_LIMIT_MS,
} from "../shared/learn/compile.js";
import {
  DEFAULT_BUDGETS,
  normalizeBlueprint,
} from "../shared/replay/blueprint.js";
import { runReplay } from "../shared/replay/engine.js";
import { loadParityFixture } from "./helpers/learn-fixtures.js";

// L04 (L0 §4): the compiled learned blueprint passes normalizeBlueprint under
// the single authorized origin and drives the fixture replay to the same
// (entityType, sourceId) set as the quarantined legacy oracle's blueprint.
// Plus the D-L0-4 extension gate (a throw = zero requests) and the invariant-1
// metamorphic test: renaming the origin changes nothing but the origin.

const FIXTURE = loadParityFixture();
const HINTS = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./fixtures/learn/legacy-parity-hints.json", import.meta.url),
    ),
    "utf8",
  ),
);
const ORIGIN = FIXTURE.authorizedOrigin;
const CLIENTS = JSON.parse(FIXTURE.capture[0].responseBody).clients;

function digestOf(capture = FIXTURE.capture, origin = ORIGIN) {
  return buildStructureDigest(capture, {
    authorizedOrigin: origin,
    links: FIXTURE.links,
  });
}

// The same capture behind a per-tenant prefix: `/proxy/api/...` becomes
// `/tenant-alice/api/...`, so every template carries one session slot.
const SLOTTED = FIXTURE.capture.map((entry) => ({
  ...entry,
  url: entry.url.replace("/proxy/", "/tenant-alice/"),
}));
function slottedCompile(overrides = {}) {
  const built = digestOf(SLOTTED);
  return compileLearnedBlueprint({
    digest: built.digest,
    hints: HINTS,
    slots: built.slots,
    authorizedOrigin: ORIGIN,
    ...overrides,
  });
}

// Deterministic fake source keyed on path + page; the oracle's `per_page`
// query value is irrelevant to routing, as it must be for a learned crawl.
function fixtureFetch(origin) {
  const calls = [];
  async function fetchJson(url, init) {
    const parsed = new URL(url);
    calls.push({ url, method: init.method, headers: init.headers });
    if (parsed.origin !== origin) throw new Error(`off-origin request ${url}`);
    const notes = parsed.pathname.match(
      /^\/proxy\/api\/clients\/(\d+)\/notes$/,
    );
    if (notes) return { notes: FIXTURE.notesByClient[notes[1]] ?? [] };
    if (parsed.pathname === "/proxy/api/clients")
      return parsed.searchParams.get("page") === "1"
        ? { clients: CLIENTS, page: 1, total: CLIENTS.length }
        : { clients: [], page: 2, total: CLIENTS.length };
    throw new Error(`fixture has no response for ${url}`);
  }
  return { fetchJson, calls };
}

async function replay(blueprint, origin) {
  const { fetchJson, calls } = fixtureFetch(origin);
  const emitted = new Set();
  const result = await runReplay({
    blueprint,
    allowedOrigins: [origin],
    fetchJson,
    emit: async (entityType, batch) => {
      for (const record of batch)
        emitted.add(`${entityType}:${record.sourceId}`);
    },
    now: () => Date.parse("2026-07-15T12:00:00.000Z"),
    sleep: async () => {},
  });
  return { result, emitted, calls };
}

function compile(overrides = {}) {
  const built = digestOf();
  return compileLearnedBlueprint({
    digest: built.digest,
    hints: HINTS,
    slots: built.slots,
    authorizedOrigin: ORIGIN,
    ...overrides,
  });
}

describe("L04 — compiled learned blueprint", () => {
  it("passes normalizeBlueprint under the authorized origin with device-derived apiBase, headers and budgets", () => {
    const blueprint = compile();
    expect(() =>
      normalizeBlueprint(blueprint, { allowedOrigins: [ORIGIN] }),
    ).not.toThrow();
    expect(blueprint.apiBase).toBe(`${ORIGIN}/proxy/api`);
    expect(blueprint.platform).toBe(new URL(ORIGIN).hostname);
    expect(blueprint.headers).toEqual({
      accept: "application/json, text/html",
      role: "Trainer",
    });
    expect(blueprint.budgets).toEqual(DEFAULT_BUDGETS);
    expect(blueprint.rateLimitMs).toBe(LEARNED_RATE_LIMIT_MS);
    expect(
      blueprint.steps.map((s) => [s.id, s.template, s.forEach, s.pagination]),
    ).toEqual([
      ["clients", "/clients", null, { style: "page", param: "page", start: 1 }],
      ["notes", "/clients/:p1/notes", "clientIds", null],
    ]);
    expect(JSON.parse(JSON.stringify(blueprint))).toEqual(blueprint);
  });

  it("drives the fixture replay to the same (entityType, sourceId) set as legacy/", async () => {
    const learned = await replay(compile(), ORIGIN);
    const legacy = await replay(truecoachBlueprint(), ORIGIN);
    expect(learned.emitted).toEqual(legacy.emitted);
    expect([...learned.emitted].sort()).toEqual([
      "clients:7",
      "clients:8",
      "notes:701",
      "notes:702",
      "notes:801",
    ]);
    expect(learned.result.entityCounts).toEqual(legacy.result.entityCounts);
    expect(learned.calls.map((c) => new URL(c.url).pathname)).toEqual(
      legacy.calls.map((c) => new URL(c.url).pathname),
    );
    for (const call of learned.calls) {
      expect(call.method).toBe("GET");
      expect(call.headers).toMatchObject({ role: "Trainer" });
      expect(new URL(call.url).origin).toBe(ORIGIN);
    }
  });

  it("exposes a registry entry for X1's register(matches, factory) that matches only the authorized origin", () => {
    const built = digestOf();
    const entry = learnedRegistration({
      digest: built.digest,
      hints: HINTS,
      slots: built.slots,
      authorizedOrigin: ORIGIN,
    });
    expect(entry.matches(ORIGIN)).toBe(true);
    expect(entry.matches("https://other.example")).toBe(false);
    expect(entry.matches(`${ORIGIN}/`)).toBe(false);
    const first = entry.factory(),
      second = entry.factory();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.steps[0].template = "/tampered";
    expect(entry.factory().steps[0].template).toBe("/clients");
  });
});

describe("key slots and origin labels are rebound on the device", () => {
  const TENANT = "https://alice.site.example";
  const keyed = (body) =>
    [101, 202].map((id) => ({
      url: `${TENANT}/api/clients/${id}/workouts`,
      method: "GET",
      statusCode: 200,
      requestHeaders: { Accept: "application/json" },
      responseBody: JSON.stringify(body(id)),
    }));
  const capture = [
    {
      url: `${TENANT}/api/clients`,
      method: "GET",
      statusCode: 200,
      requestHeaders: { Accept: "application/json" },
      responseBody: JSON.stringify({
        zorbix: [
          { quux: 101, name: "A" },
          { quux: 202, name: "B" },
        ],
      }),
    },
    ...keyed((id) => ({ alice: [{ id: id * 10 }] })),
  ];
  const steps = [
    {
      templateRef: "t0",
      entityType: "clients",
      itemsPath: [":k1"],
      idField: ":k2",
      collectAs: "clientIds",
      pagination: null,
    },
    {
      templateRef: "t1",
      entityType: "workouts",
      itemsPath: [":k1"],
      idField: "id",
      forEach: "clientIds",
      pagination: null,
    },
  ];

  it("compiles slotted keys back to the raw response keys, under the tenant origin", () => {
    const built = buildStructureDigest(capture, { authorizedOrigin: TENANT });
    expect(
      built.digest.templates.map((t) => [t.ref, t.template, t.collectionPaths]),
    ).toEqual([
      ["t0", "/api/clients", [[":k1"]]],
      ["t1", "/api/clients/:p1/workouts", [[":k1"]]],
    ]);
    expect(built.slots.keys).toEqual({
      t0: { ":k1": "zorbix", ":k2": "quux" },
      t1: { ":k1": "alice" },
    });
    const blueprint = compileLearnedBlueprint({
      digest: built.digest,
      hints: { steps },
      slots: built.slots,
      authorizedOrigin: TENANT,
    });
    expect(blueprint.platform).toBe("alice.site.example");
    expect(blueprint.apiBase).toBe(`${TENANT}/api`);
    expect(blueprint.steps.map((s) => [s.itemsPath, s.idField])).toEqual([
      [["zorbix"], "quux"],
      [["alice"], "id"],
    ]);
    expect(() =>
      normalizeBlueprint(blueprint, { allowedOrigins: [TENANT] }),
    ).not.toThrow();
  });

  it("refuses a missing or unsafe key slot, and an origin outside the digest's platform", () => {
    const built = buildStructureDigest(capture, { authorizedOrigin: TENANT });
    const compileWith = (slots, origin = TENANT) =>
      compileLearnedBlueprint({
        digest: built.digest,
        hints: { steps },
        slots,
        authorizedOrigin: origin,
      });
    expect(() => compileWith({ ...built.slots, keys: {} })).toThrow(
      "learn_compile_missing_slot",
    );
    expect(() =>
      compileWith({
        ...built.slots,
        keys: {
          ...built.slots.keys,
          t0: { ":k1": "zorbix", ":k2": "access_token" },
        },
      }),
    ).toThrow("learn_compile_invalid_slot");
    expect(() =>
      compileWith({
        ...built.slots,
        keys: { ...built.slots.keys, t0: { ":k1": "zorbix", ":k2": "a b" } },
      }),
    ).toThrow("learn_compile_invalid_slot");
    expect(() =>
      compileWith(built.slots, "https://bob.site.example"),
    ).not.toThrow();
    expect(() =>
      compileWith(built.slots, "https://site.example"),
    ).not.toThrow();
    expect(() => compileWith(built.slots, "https://other.example")).toThrow(
      "learn_compile_invalid_digest",
    );
    expect(() => compileWith(built.slots, "https://notsite.example")).toThrow(
      "learn_compile_invalid_digest",
    );
  });
});

describe("D-L0-4 extension gate — a throw means zero requests", () => {
  const cases = [
    [
      "unknown template ref",
      { hints: { steps: [{ ...HINTS.steps[0], templateRef: "t9" }] } },
      "learn_compile_unknown_template_ref",
    ],
    [
      "template without collection role",
      { hints: { steps: [{ ...HINTS.steps[0], templateRef: "t0" }] } },
      "learn_compile_template_not_collection",
    ],
    [
      "items path not offered by the digest",
      { hints: { steps: [{ ...HINTS.steps[0], itemsPath: ["rows"] }] } },
      "learn_compile_items_path",
    ],
    [
      "id field without an id class",
      { hints: { steps: [{ ...HINTS.steps[0], idField: "name" }] } },
      "learn_compile_id_field",
    ],
    [
      "pagination param not a digest query key",
      {
        hints: {
          steps: [
            {
              ...HINTS.steps[0],
              pagination: { style: "page", param: "offset" },
            },
          ],
        },
      },
      "learn_compile_pagination",
    ],
    [
      "cursor pagination without a string nextPath",
      {
        hints: {
          steps: [
            {
              ...HINTS.steps[0],
              pagination: {
                style: "cursor",
                param: "page",
                nextPath: ["total"],
              },
            },
          ],
        },
      },
      "learn_compile_pagination",
    ],
    [
      "forEach over a set no earlier step collects",
      { hints: { steps: [HINTS.steps[1]] } },
      "learn_compile_for_each",
    ],
    [
      "parameterised template without forEach",
      {
        hints: {
          steps: [{ ...HINTS.steps[1], forEach: undefined, templateRef: "t2" }],
        },
      },
      "learn_compile_for_each",
    ],
    [
      "unparameterised template with forEach",
      {
        hints: {
          steps: [
            HINTS.steps[0],
            { ...HINTS.steps[1], templateRef: "t1", itemsPath: ["clients"] },
          ],
        },
      },
      "learn_compile_for_each",
    ],
    [
      "duplicate entity type",
      {
        hints: {
          steps: [HINTS.steps[0], { ...HINTS.steps[0], collectAs: "again" }],
        },
      },
      "learn_compile_entity_type",
    ],
    [
      "entity type outside the grammar",
      { hints: { steps: [{ ...HINTS.steps[0], entityType: "Clients!" }] } },
      "learn_compile_entity_type",
    ],
    [
      "unknown step key",
      {
        hints: {
          steps: [{ ...HINTS.steps[0], apiBase: "https://evil.example" }],
        },
      },
      "learn_compile_invalid_hints",
    ],
    [
      "too many steps",
      {
        hints: {
          steps: Array.from({ length: 9 }, (_, i) => ({
            ...HINTS.steps[0],
            entityType: `e${i}`,
            collectAs: `c${i}`,
          })),
        },
      },
      "learn_compile_invalid_hints",
    ],
    ["no steps", { hints: { steps: [] } }, "learn_compile_invalid_hints"],
    [
      "http origin",
      { authorizedOrigin: "http://app.example" },
      "learn_compile_invalid_origin",
    ],
    [
      "origin that is not the digest's platform",
      { authorizedOrigin: "https://other.example" },
      "learn_compile_invalid_digest",
    ],
  ];
  for (const [name, overrides, code] of cases)
    it(`refuses: ${name} (${code})`, () => {
      expect(() => compile(overrides)).toThrow(code);
    });

  it("fills session slots from the device and keeps the slug out of the digest", () => {
    const built = digestOf(SLOTTED);
    expect(built.digest.templates.map((t) => t.template)).toEqual([
      "/:s1/api/auth/session",
      "/:s1/api/clients",
      "/:s1/api/clients/:p1/notes",
      "/:s1/api/trainers/me",
    ]);
    expect(built.slots.templates).toEqual({
      t0: ["tenant-alice"],
      t1: ["tenant-alice"],
      t2: ["tenant-alice"],
      t3: ["tenant-alice"],
    });
    expect(canonicalJson(built.digest)).not.toContain("tenant-alice");
    const blueprint = slottedCompile();
    expect(blueprint.apiBase).toBe(`${ORIGIN}/tenant-alice/api`);
    expect(blueprint.steps.map((s) => s.template)).toEqual([
      "/clients",
      "/clients/:p1/notes",
    ]);
    expect(() =>
      normalizeBlueprint(blueprint, { allowedOrigins: [ORIGIN] }),
    ).not.toThrow();
  });

  it("refuses when a session slot is missing, or a template does not match the device slots or the grammar", () => {
    expect(() => slottedCompile({ slots: {} })).toThrow(
      "learn_compile_missing_slot",
    );
    expect(() =>
      slottedCompile({
        slots: { templates: { t1: ["a", "b"] }, links: {}, headers: {} },
      }),
    ).toThrow("learn_compile_missing_slot");
    const built = digestOf();
    const digest = structuredClone(built.digest);
    digest.templates[1].template = "/evil.example/clients";
    expect(() => compile({ digest })).toThrow("learn_compile_invalid_digest");
    digest.templates[1].template = "/proxy/api/Clients";
    expect(() => compile({ digest })).toThrow("learn_compile_invalid_digest");
    digest.templates[1].template = "/proxy/api/clients?x=1";
    expect(() => compile({ digest })).toThrow("learn_compile_invalid_digest");
    digest.templates[1].template = "/proxy/api//clients";
    expect(() => compile({ digest })).toThrow("learn_compile_invalid_digest");
  });

  it("refuses slot or header values that could change the path or the request line", () => {
    const built = digestOf(SLOTTED);
    for (const bad of [
      "..",
      ".",
      "",
      "a/b",
      "x?y",
      "x#y",
      "x\\y",
      "with\nnewline",
    ]) {
      const slots = structuredClone(built.slots);
      slots.templates.t1 = [bad];
      expect(() => slottedCompile({ slots }), JSON.stringify(bad)).toThrow(
        /learn_compile_(?:invalid|missing)_slot/,
      );
    }
    const headerSlots = structuredClone(built.slots);
    headerSlots.headers.role = "x\r\nInjected: 1";
    expect(() => slottedCompile({ slots: headerSlots })).toThrow(
      "learn_compile_header",
    );
  });

  it("propagates the normalizer's refusal as learn_compile_rejected with the cause", () => {
    const built = digestOf();
    const digest = structuredClone(built.digest);
    digest.templates[1].queryKeys.push("bad key");
    const hints = {
      steps: [
        { ...HINTS.steps[0], pagination: { style: "page", param: "bad key" } },
      ],
    };
    expect(() => compile({ digest, hints })).not.toThrow();
    const digest2 = structuredClone(built.digest);
    digest2.constantHeaders["x-bad"] = "\u0001";
    const error = (() => {
      try {
        compile({ digest: digest2 });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error.message).toBe("learn_compile_header");
  });
});

describe("invariant 1 — metamorphic origin rename", () => {
  const RENAMED = "https://coaching.renamed-site.example";
  const renamed = FIXTURE.capture.map((entry) => ({
    ...entry,
    url: entry.url.replace(ORIGIN, RENAMED),
    requestHeaders: Object.fromEntries(
      Object.entries(entry.requestHeaders).map(([k, v]) => [
        k,
        v.replace(ORIGIN, RENAMED),
      ]),
    ),
  }));

  it("digests to identical structure except the origin slot", () => {
    const a = digestOf(),
      b = buildStructureDigest(renamed, {
        authorizedOrigin: RENAMED,
        links: FIXTURE.links.map((l) => l.replace(ORIGIN, RENAMED)),
      });
    expect(
      canonicalJson({ ...b.digest, sourcePlatform: a.digest.sourcePlatform }),
    ).toBe(canonicalJson(a.digest));
    expect(b.digest.sourcePlatform).toBe("renamed-site.example");
    expect(b.slots.origin).toEqual(["coaching"]);
    expect({ ...b.slots, origin: a.slots.origin }).toEqual(a.slots);
  });

  it("compiles to an identical blueprint except apiBase/platform and replays the same set", async () => {
    const a = compile();
    const built = buildStructureDigest(renamed, { authorizedOrigin: RENAMED });
    const b = compileLearnedBlueprint({
      digest: built.digest,
      hints: HINTS,
      slots: built.slots,
      authorizedOrigin: RENAMED,
    });
    expect({ ...b, apiBase: a.apiBase, platform: a.platform }).toEqual(a);
    expect(b.apiBase).toBe(`${RENAMED}/proxy/api`);
    const replayed = await replay(b, RENAMED);
    expect(replayed.emitted).toEqual((await replay(a, ORIGIN)).emitted);
  });

  it("shared/learn contains no hostname, vendor or slug literal", () => {
    for (const file of ["digest.js", "compile.js", "fingerprint.js"]) {
      const source = readFileSync(
        fileURLToPath(new URL(`../shared/learn/${file}`, import.meta.url)),
        "utf8",
      );
      expect(source).not.toMatch(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
      expect(source).not.toMatch(/\.(?:co|com|io|app)\b/);
    }
  });
});
