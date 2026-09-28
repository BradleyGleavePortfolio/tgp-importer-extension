import { describe, expect, it } from "vitest";
import {
  buildStructureDigest,
  canonicalJson,
  DIGEST_LIMITS,
  shapeOf,
  stringClass,
} from "../shared/learn/digest.js";
import { fingerprintMaterial } from "../shared/learn/fingerprint.js";
import { VOCABULARY } from "../shared/learn/vocabulary.js";
import { loadConformanceFixture } from "./helpers/conformance-alpha.js";
import {
  assertValueFree,
  captureValues,
  conformanceCapture,
  loadParityFixture,
} from "./helpers/learn-fixtures.js";

// L03 (L0 §4) plus C2B1-SOL-A1 / C2B1-SOL-X2-1: the digest is the device-side
// PII boundary. It carries structure only — every value, id, name, email,
// header value outside the constant-header rule, query value, full URL, link
// text and unestablished path literal must be absent from its canonical bytes.

const ORIGIN = "https://coach-portal.example";
const HEADERS = {
  Accept: "application/json",
  Authorization: "<redacted>",
  Cookie: "<redacted>",
};

function entry(path, body, overrides = {}) {
  return {
    url: `${ORIGIN}${path}`,
    method: "GET",
    statusCode: 200,
    capturedAt: "2026-09-01T10:00:00.000Z",
    requestHeaders: HEADERS,
    responseBody: JSON.stringify(body),
    ...overrides,
  };
}

function build(capture, options = {}) {
  return buildStructureDigest(capture, {
    authorizedOrigin: ORIGIN,
    ...options,
  });
}

function templateNamed(digest, suffix) {
  const found = digest.templates.find((t) => t.template.endsWith(suffix));
  expect(found, `template ending in ${suffix}`).toBeDefined();
  return found;
}

// Values the constant-header rule legitimately transmits in clear.
function clearHeaderValues(digest) {
  return Object.values(digest.constantHeaders).filter(
    (v) => !/^:h\d+$/.test(v),
  );
}

describe("L03 — the legacy-shaped fixture capture digests to structure only", () => {
  const fixture = loadParityFixture();
  const result = buildStructureDigest(fixture.capture, {
    authorizedOrigin: fixture.authorizedOrigin,
    links: fixture.links,
  });
  const text = canonicalJson(result.digest);

  it("contains no body value, id, name, email, header value, query value or URL", () => {
    const values = captureValues(fixture.capture);
    for (const clear of clearHeaderValues(result.digest)) values.delete(clear);
    assertValueFree(text, values, expect);
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/https?:/);
    expect(text).not.toMatch(/Bearer|eyJ/);
  });

  it("lists every observed collection with its role, paths and a key/kind shape", () => {
    const clients = templateNamed(result.digest, "/clients");
    expect(clients.role).toBe("collection");
    expect(clients.collectionPaths).toEqual([["clients"]]);
    expect(clients.queryKeys).toEqual(["page", "per_page"]);
    expect(clients.statuses).toEqual([200]);
    expect(clients.observations).toBe(2);
    expect(clients.shape.keys.clients.items.keys).toEqual({
      email: { kind: "string", class: "email_like", lengthBucket: "≤32" },
      id: { kind: "number", class: "int" },
      name: { kind: "string", class: "text", lengthBucket: "≤32" },
    });
    const notes = templateNamed(result.digest, "/clients/:p1/notes");
    expect(notes.role).toBe("collection");
    expect(notes.collectionPaths).toEqual([["notes"]]);
    expect(notes.observations).toBe(2);
  });

  it("transmits vocabulary words in clear and lists every non-collection route with its refusal reason", () => {
    expect(
      result.digest.templates.map((t) => [
        t.ref,
        t.template,
        t.role,
        t.refusal,
      ]),
    ).toEqual([
      ["t0", "/proxy/api/auth/session", "refused", "unsafe_path_key"],
      ["t1", "/proxy/api/clients", "collection", null],
      ["t2", "/proxy/api/clients/:p1/notes", "collection", null],
      ["t3", "/proxy/api/trainers/me", "refused", "metadata_only"],
    ]);
    expect(result.slots.templates).toEqual({});
    expect(result.digest.vocabularyVersion).toBe(1);
    expect(result.digest.templates[1].queryVariants).toEqual({
      page: 2,
      per_page: 1,
    });
    // The redacted access_token query name is counted, never named.
    expect(result.digest.templates[1].withheldQueryKeys).toBe(1);
    expect(text).not.toMatch(/access_token/);
  });

  it("transmits link templates without text, query, fragment or foreign origins", () => {
    expect(result.digest.linkTemplates).toEqual([
      "/clients",
      "/clients/:p1",
      "/clients/:p1/notes",
      "/dashboard",
      "/trainers/me/settings",
    ]);
    expect(result.digest.exploredLinkTemplates).toEqual([]);
    expect(text).not.toMatch(/tab=|#top|help\.example/);
    expect(result.digest.withheld).toEqual([
      { reason: "foreign_link", count: 1 },
    ]);
    expect(result.excluded).toEqual(result.digest.withheld);
    const explored = buildStructureDigest(fixture.capture, {
      authorizedOrigin: fixture.authorizedOrigin,
      links: fixture.links,
      exploredLinks: ["/clients/8", "/nowhere"],
    });
    expect(explored.digest.exploredLinkTemplates).toEqual(["/clients/:p1"]);
  });

  it("applies the constant-header rule: MIME list in clear, role as a slot, ids and denied names dropped", () => {
    expect(result.digest.constantHeaders).toEqual({
      accept: "application/json, text/html",
      role: ":h1",
    });
    expect(result.slots.headers).toEqual({ role: "Trainer" });
    expect(text).not.toMatch(
      /Trainer|Mozilla|3f1c9d2e|x-request-id|referer|sec-fetch/,
    );
  });

  it("is deterministic and order-independent", () => {
    const reversed = buildStructureDigest([...fixture.capture].reverse(), {
      authorizedOrigin: fixture.authorizedOrigin,
      links: [...fixture.links].reverse(),
    });
    expect(canonicalJson(reversed.digest)).toBe(text);
    expect(reversed.slots).toEqual(result.slots);
  });

  it("stays within the D-L0-2 bounds", () => {
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
      DIGEST_LIMITS.maxBytes,
    );
    expect(result.digest.truncated).toBe(false);
    expect(result.digest.templates.map((t) => t.ref)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
    ]);
    expect(result.digest).toMatchObject({
      digestVersion: 1,
      // Only the last two host labels travel (C2B1-SOL2-C1).
      sourcePlatform: new URL(fixture.authorizedOrigin).hostname
        .split(".")
        .slice(-2)
        .join("."),
      originLabelsWithheld: 1,
      round: 1,
      missingFamilies: [],
    });
  });
});

describe("L03 — conformance_alpha digests to structure only", () => {
  const fixture = loadConformanceFixture();
  const capture = conformanceCapture(fixture);
  const result = buildStructureDigest(capture, {
    authorizedOrigin: fixture.apiBase,
  });
  const text = canonicalJson(result.digest);

  it("contains no value from the response map, including cursors and string ids", () => {
    const values = captureValues(capture);
    for (const clear of clearHeaderValues(result.digest)) values.delete(clear);
    assertValueFree(text, values, expect);
    expect(text).not.toMatch(/ca_1001|m-500|mc1|Rivera|Denver|member\.test/);
  });

  it("lists every observed template with the roles.js verdict, a clear key word and slots", () => {
    // roles.js refuses lists whose items differ in key set (the fixture's
    // deliberately omitted optional fields and poison rows), so the verdicts
    // are `refused`; the templates are still listed with their shapes.
    expect(
      result.digest.templates.map((t) => [t.template, t.role, t.observations]),
    ).toEqual([
      ["/v2/coaches", "refused", 1],
      ["/v2/coaches/:p1/:s1", "refused", 3],
      ["/v2/coaches/:p1/members", "refused", 3],
      ["/v2/coaches/:p1/routines", "refused", 2],
    ]);
    expect(result.slots.templates).toEqual({ t1: ["activity-log"] });
    const members = templateNamed(result.digest, "/members");
    expect(members.queryKeys).toEqual(["after"]);
    expect(members.shape.keys.paging).toEqual({
      kind: "object",
      keys: {
        after: { kind: "string", class: "short_id", lengthBucket: "≤8" },
      },
      optional: ["after"],
    });
    // Poison rows (a scalar element) make the item shape `mixed`, so the
    // members array is not offered as a collection path.
    expect(members.shape.keys.members.items).toEqual({ kind: "mixed" });
    expect(members.collectionPaths).toEqual([]);
    const coaches = templateNamed(result.digest, "/v2/coaches");
    // `region` is not a vocabulary key: it travels as a key slot.
    expect(coaches.shape.keys.coaches.items.optional).toEqual([":k1"]);
    expect(result.slots.keys[coaches.ref]).toEqual({ ":k1": "region" });
    expect(text).not.toMatch(/region/);
    expect(coaches.shape.keys.coaches.items.keys.profile.optional).toEqual([
      "timezone",
    ]);
  });

  it("drops the build header (digit run) and never echoes the cursor value", () => {
    expect(result.digest.constantHeaders).toEqual({
      accept: "application/json",
    });
    expect(text).not.toMatch(/2026\.07/);
  });
});

describe("C2B1-SOL-A1 — a fixed per-coach literal never leaves the device", () => {
  for (const slug of ["alice", "jane-doe", "private-tenant"]) {
    it(`withholds "${slug}" when another position of the same path varies`, () => {
      const capture = [101, 202, 303].map((id) =>
        entry(`/coaches/${slug}/clients/${id}/workouts`, {
          items: [{ id: 5 }],
        }),
      );
      const { digest, slots } = build(capture, {
        links: [`/coaches/${slug}/clients/101`, `/coaches/${slug}/clients/202`],
      });
      const text = canonicalJson(digest);
      expect(text).not.toContain(slug);
      expect(fingerprintMaterial(digest).join("\n")).not.toContain(slug);
      expect(digest.templates).toHaveLength(1);
      expect(digest.templates[0]).toMatchObject({
        template: "/coaches/:s1/clients/:p1/workouts",
        role: "collection",
        collectionPaths: [["items"]],
        observations: 3,
      });
      expect(slots.templates.t0).toEqual([slug]);
      expect(digest.linkTemplates).toEqual(["/coaches/:s1/clients/:p1"]);
      expect(slots.links).toEqual({ "/coaches/:s1/clients/:p1": [slug] });
    });
  }

  it("a shape key of this capture is NOT proof: only the closed vocabulary is", () => {
    const { digest, slots } = build([
      entry("/zorbix/clients", { clients: [{ id: 1, zorbix: 1 }] }),
    ]);
    expect(digest.templates[0].template).toBe("/:s1/clients");
    expect(slots.templates.t0).toEqual(["zorbix"]);
    // The same word as a response key is a key slot, not proof either way.
    expect(digest.templates[0].shape.keys.clients.items.keys).toEqual({
      ":k1": { kind: "number", class: "int" },
      id: { kind: "number", class: "int" },
    });
    expect(slots.keys.t0).toEqual({ ":k1": "zorbix" });
    expect(canonicalJson(digest)).not.toContain("zorbix");
  });

  it("positive control: vocabulary words around the slug stay in clear", () => {
    const capture = [
      entry("/coaches/alice/clients", {
        clients: [
          { id: 1, workouts: 3 },
          { id: 2, workouts: 0 },
        ],
      }),
      entry("/coaches/alice/clients/1/workouts", { workouts: [{ id: 9 }] }),
      entry("/coaches/alice/clients/2/workouts", { workouts: [{ id: 10 }] }),
    ];
    const { digest } = build(capture);
    expect(digest.templates.map((t) => t.template)).toEqual([
      "/coaches/:s1/clients",
      "/coaches/:s1/clients/:p1/workouts",
    ]);
    expect(canonicalJson(digest)).not.toContain("alice");
  });

  it("a lone client id is a session slot, two distinct ids are an item parameter", () => {
    const one = build([entry("/api/clients/7/notes", { notes: [{ id: 1 }] })]);
    expect(one.digest.templates[0].template).toBe("/api/clients/:s1/notes");
    expect(one.slots.templates.t0).toEqual(["7"]);
    const two = build([
      entry("/api/clients/7/notes", { notes: [{ id: 1 }] }),
      entry("/api/clients/8/notes", { notes: [{ id: 2 }] }),
    ]);
    expect(two.digest.templates[0].template).toBe("/api/clients/:p1/notes");
  });

  it("C2B1-SOL2-A1: a container keyed by the coach's name is a key slot; C2B1-SOL2-C1: a tenant host label is an origin slot", () => {
    const tenant = "https://alice.site.example";
    const capture = [101, 202, 303].map((id) => ({
      url: `${tenant}/coaches/alice/clients/${id}/workouts`,
      method: "GET",
      statusCode: 200,
      requestHeaders: { Accept: "application/json" },
      responseBody: JSON.stringify({ alice: [{ id: 5 }] }),
    }));
    const { digest, slots } = buildStructureDigest(capture, {
      authorizedOrigin: tenant,
    });
    expect(canonicalJson(digest)).not.toContain("alice");
    expect(digest.sourcePlatform).toBe("site.example");
    expect(digest.originLabelsWithheld).toBe(1);
    expect(digest.templates[0]).toMatchObject({
      template: "/coaches/:s1/clients/:p1/workouts",
      role: "collection",
      collectionPaths: [[":k1"]],
    });
    expect(digest.templates[0].shape.keys[":k1"].items.keys).toEqual({
      id: { kind: "number", class: "int" },
    });
    expect(slots).toEqual({
      origin: ["alice"],
      templates: { t0: ["alice"] },
      keys: { t0: { ":k1": "alice" } },
      links: {},
      headers: {},
    });
    // Byte-identical to the same capture keyed by a vocabulary-free word.
    const other = buildStructureDigest(
      capture.map((e) => ({
        ...e,
        responseBody: e.responseBody.replace("alice", "zorbix"),
      })),
      { authorizedOrigin: tenant },
    );
    expect(canonicalJson(other.digest)).toBe(canonicalJson(digest));
  });

  it("proof seam (b): a slot may carry only what the salted per-run hash returns", () => {
    const capture = [entry("/coaches/alice/clients", { clients: [{ id: 1 }] })];
    const plain = build(capture);
    expect(plain.digest).not.toHaveProperty("slotProofs");
    const proven = build(capture, {
      slotProof: (word) => `${"ab".repeat(8)}${word.length.toString(16)}`,
    });
    expect(proven.digest.slotProofs).toEqual({ t0: ["abababababababab5"] });
    expect(canonicalJson(proven.digest)).not.toContain("alice");
    for (const bad of [(word) => word, () => "ALICE", () => 7, () => "short"])
      expect(() => build(capture, { slotProof: bad })).toThrow(
        "learn_digest_invalid_slot_proof",
      );
  });

  it("two endpoints that mask to the same template are listed once and refused", () => {
    const { digest, slots, excluded } = build([
      entry("/api/zorbix", [{ id: 1, title: "Base" }]),
      entry("/api/quuxel", [{ id: 1, title: "Squat" }]),
    ]);
    expect(digest.templates).toHaveLength(1);
    expect(digest.templates[0]).toMatchObject({
      template: "/api/:s1",
      role: "refused",
      refusal: "template_collision",
      observations: 2,
    });
    expect(slots.templates).toEqual({});
    expect(excluded).toContainEqual({ reason: "template_collision", count: 2 });
    expect(canonicalJson(digest)).not.toMatch(/zorbix|quuxel|Squat/);
  });
});

// Deterministic PRNG so a failure is reproducible from the seed.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
function letters(random, length) {
  return Array.from({ length }, () =>
    String.fromCharCode(97 + Math.floor(random() * 26)),
  ).join("");
}
const KEYS = [
  "id",
  "name",
  "email",
  "phone",
  "notes",
  "created_at",
  "status",
  "profile",
  "items",
  "clients",
  "data",
  "results",
  "tags",
  "score",
  "active",
];

// Plant a unique marker in EVERY value position of a random capture; the
// digest and the fingerprint pre-image must contain none of them.
function plantedCapture(random) {
  const markers = new Set();
  const mark = (prefix) => {
    const token = `${prefix}${letters(random, 10)}`;
    markers.add(token);
    return token;
  };
  const value = (depth) => {
    const roll = random();
    if (depth < 3 && roll < 0.15)
      return {
        [KEYS[Math.floor(random() * KEYS.length)]]: value(depth + 1),
        [mark("kk")]: mark("vv"),
      };
    if (depth < 3 && roll < 0.3) return [value(depth + 1), value(depth + 1)];
    if (roll < 0.45) return `${mark("vv")}@${mark("vv")}.test`;
    if (roll < 0.55)
      return `+1 ${Math.floor(random() * 900 + 100)} 555 ${Math.floor(random() * 9000 + 1000)}`;
    if (roll < 0.65)
      return Number(String(Math.floor(random() * 1e9)).padStart(6, "7"));
    if (roll < 0.75) return `https://${mark("vv")}.example/${mark("vv")}`;
    return mark("vv");
  };
  const slug = mark("zz"),
    tenant = mark("hv");
  const capture = [];
  const count = 2 + Math.floor(random() * 4);
  for (let index = 0; index < count; index += 1) {
    const id = String(Math.floor(random() * 1e6) + 1000);
    markers.add(id);
    const items = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
      id: Number(id) + Math.floor(random() * 10),
      name: mark("vv"),
      email: `${mark("vv")}@example.test`,
      profile: { bio: mark("vv"), city: mark("vv") },
    }));
    capture.push(
      entry(
        `/${slug}/${mark("zz")}/clients/${id}/notes?cursor=${mark("vv")}&${mark("qq")}=${mark("vv")}`,
        {
          notes: items,
          meta: { next: mark("vv"), total: items.length },
          [mark("kk")]: value(0),
        },
        {
          requestHeaders: {
            ...HEADERS,
            "X-Tenant": tenant,
            "X-Trace": `${mark("hv")}-${index}`,
            Referer: `${ORIGIN}/${slug}/${mark("vv")}`,
          },
        },
      ),
    );
  }
  const links = [
    `/${slug}/settings`,
    `/${slug}/clients/${mark("vv")}?tab=${mark("vv")}#${mark("vv")}`,
    `https://${mark("vv")}.other.test/${mark("vv")}`,
  ];
  return { capture, links, markers };
}

describe("L03 — property: planted values never survive", () => {
  it("scrubs every planted marker over 150 random captures", () => {
    const random = rng(0x5eed);
    for (let round = 0; round < 150; round += 1) {
      const { capture, links, markers } = plantedCapture(random);
      const { digest } = build(capture, { links });
      const text = `${canonicalJson(digest)}\n${fingerprintMaterial(digest).join("\n")}`;
      for (const marker of markers)
        if (!/^kk/.test(marker))
          expect(text, `round ${round}: "${marker}" survived`).not.toContain(
            marker,
          );
      expect(text).not.toMatch(/@|https?:|Bearer/);
      // Object keys are structure by contract, but a key that carries a value
      // shape (digits / id-like) is dropped; planted "kk" keys are plain words.
      expect(digest.templates.length).toBeGreaterThan(0);
      expect(
        digest.templates.every((t) => t.template.startsWith("/:s1/:s2/")),
      ).toBe(true);
      expect(Object.keys(digest.constantHeaders).sort()).toEqual([
        "accept",
        "x-tenant",
      ]);
      expect(digest.constantHeaders["x-tenant"]).toBe(":h1");
    }
  });
});

// Distinct vocabulary words: in clear, so each makes its own template.
const WORDS = [...VOCABULARY].sort();
function word(index) {
  return WORDS[index];
}

describe("shape classes and bounds", () => {
  it("classifies strings by class, never by value", () => {
    expect(stringClass("42")).toBe("int_id");
    expect(stringClass("3f1c9d2e-8a41-4c2f-9b7d-0f5e6a7b8c9d")).toBe("uuid");
    expect(stringClass("2026-07-01T10:00:00Z")).toBe("iso_date");
    expect(stringClass("2026-07-01")).toBe("iso_date");
    expect(stringClass("dana@example.com")).toBe("email_like");
    expect(stringClass("+1 (555) 010-9999")).toBe("phone_like");
    expect(stringClass("https://example.test/x")).toBe("url");
    expect(stringClass("ca_1001")).toBe("short_id");
    expect(stringClass("Alex Rivera")).toBe("text");
    expect(stringClass("active")).toBe("text");
  });

  it("drops credential and value-like keys; an object keyed by data is a map of its value shape", () => {
    expect(
      shapeOf(
        { access_token: "[REDACTED]", ok: true, address1: "x" },
        0,
        DIGEST_LIMITS,
      ),
    ).toEqual({
      kind: "object",
      keys: {
        address1: { kind: "string", class: "text", lengthBucket: "≤8" },
        ok: { kind: "boolean" },
      },
    });
    expect(shapeOf({ 42: 1, "a@b": 2 }, 0, DIGEST_LIMITS)).toEqual({
      kind: "map",
      values: { kind: "number", class: "int" },
    });
    const byDate = shapeOf(
      { "2026-01-01": { n: 1 }, "2026-01-02": { n: 2 }, total: 2 },
      0,
      DIGEST_LIMITS,
    );
    expect(byDate).toEqual({ kind: "map", values: { kind: "mixed" } });
    expect(canonicalJson(byDate)).not.toMatch(/2026/);
    // A wide, mostly-optional key set across items (a map keyed by slug) collapses too.
    const { digest } = build([
      entry("/api/stats", {
        stats: Array.from({ length: 20 }, (_, i) => ({
          [`slug${"x".repeat(i)}`]: i,
        })),
      }),
    ]);
    expect(digest.templates[0].shape.keys.stats.items).toEqual({
      kind: "map",
      values: { kind: "number", class: "int" },
    });
    expect(canonicalJson(digest)).not.toMatch(/slugx/);
  });

  it("caps depth at 4 and keys at 64 per object", () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    const shape = shapeOf(deep, 0, DIGEST_LIMITS);
    expect(shape.keys.a.keys.b.keys.c.keys.d).toEqual({
      kind: "object",
      keys: {},
    });
    const wide = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [
        `k${String(i).padStart(2, "0")}`,
        i,
      ]),
    );
    expect(Object.keys(shapeOf(wide, 0, DIGEST_LIMITS).keys)).toHaveLength(64);
  });

  it("truncates deterministically past 64 templates, collections first", () => {
    const capture = [];
    for (let index = 0; index < 70; index += 1)
      capture.push(
        entry(`/api/${word(index)}`, { [word(index)]: [{ id: index }] }),
      );
    for (let index = 0; index < 10; index += 1)
      capture.push(
        entry(`/api/one/${word(index)}`, { id: index, [word(index)]: 1 }),
      );
    const { digest } = build(capture);
    expect(digest.truncated).toBe(true);
    expect(digest.templates).toHaveLength(64);
    expect(digest.templates.every((t) => t.role === "collection")).toBe(true);
    expect(digest.templates.map((t) => t.ref)).toEqual(
      digest.templates.map((_, i) => `t${i}`),
    );
  });

  it("truncates to the 32 KiB canonical budget by dropping links first", () => {
    const capture = Array.from({ length: 60 }, (_, index) =>
      entry(`/api/${word(index)}`, {
        [word(index)]: [
          Object.fromEntries(
            Array.from({ length: 60 }, (_, k) => [
              `field_${word(k)}_${word(index)}`,
              k,
            ]),
          ),
        ],
      }),
    );
    const links = Array.from(
      { length: 64 },
      (_, index) => `/page/${word(index)}`,
    );
    const { digest } = build(capture, { links });
    expect(
      new TextEncoder().encode(canonicalJson(digest)).length,
    ).toBeLessThanOrEqual(DIGEST_LIMITS.maxBytes);
    expect(digest.truncated).toBe(true);
    expect(digest.linkTemplates.length).toBeLessThan(64);
  });
});

describe("constant-header rule", () => {
  const rows = (headersFor) =>
    Array.from({ length: 10 }, (_, index) =>
      entry(
        `/api/things/${index + 1}`,
        { id: index + 1, things: [] },
        { requestHeaders: headersFor(index) },
      ),
    );

  it("keeps a value only when byte-identical on at least 90% of same-origin requests", () => {
    const nine = build(
      rows((i) => (i < 9 ? { ...HEADERS, "X-Mode": "compact" } : HEADERS)),
    );
    expect(nine.digest.constantHeaders["x-mode"]).toBe(":h1");
    expect(nine.slots.headers).toEqual({ "x-mode": "compact" });
    const eight = build(
      rows((i) => (i < 8 ? { ...HEADERS, "X-Mode": "compact" } : HEADERS)),
    );
    expect(eight.digest.constantHeaders).toEqual({
      accept: "application/json",
    });
  });

  it("drops denied names, credential names, digit runs, ids, long and non-ASCII values", () => {
    const { digest, slots } = build(
      rows(() => ({
        ...HEADERS,
        Referer: "https://coach-portal.example/x",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": "<redacted>",
        "X-Api-Key": "<redacted>",
        "X-Account": "acct-20260701",
        "X-Session-Id": "abc123def456",
        "X-Long": "x".repeat(65),
        "X-Utf": "caf\u00e9",
        "X-Requested-With": "XMLHttpRequest",
        "X-Tenant": "alice-fitness",
      })),
    );
    // Protocol grammar in clear; a digit-free tenant slug is a slot (B6).
    expect(digest.constantHeaders).toEqual({
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
      "x-tenant": ":h1",
    });
    expect(slots.headers).toEqual({ "x-tenant": "alice-fitness" });
    expect(canonicalJson(digest)).not.toMatch(
      /acct-|abc123|same-origin|coach-portal\.example\/x|alice/,
    );
  });
});

describe("input validation", () => {
  it("refuses an unsafe or missing authorized origin", () => {
    expect(() => buildStructureDigest([], {})).toThrow(
      "invalid_authorized_origin",
    );
    expect(() =>
      buildStructureDigest([], { authorizedOrigin: "http://coach.example" }),
    ).toThrow("invalid_authorized_origin");
    expect(() =>
      buildStructureDigest([], { authorizedOrigin: "https://127.0.0.1" }),
    ).toThrow("invalid_authorized_origin");
  });

  it("excludes off-origin observations instead of digesting them", () => {
    const { digest, excluded } = build([
      entry(
        "/api/clients",
        { clients: [{ id: 1 }] },
        { url: "https://other.example/api/clients" },
      ),
    ]);
    expect(digest.templates).toEqual([]);
    expect(excluded).toEqual([{ reason: "origin_mismatch", count: 1 }]);
  });

  it("carries round 2 missing families only when valid", () => {
    const { digest } = build([], {
      round: 2,
      missingFamilies: ["workouts", "clients"],
    });
    expect(digest).toMatchObject({
      round: 2,
      missingFamilies: ["clients", "workouts"],
    });
    expect(() =>
      build([], { round: 2, missingFamilies: ["Bad Family"] }),
    ).toThrow("invalid_missing_families");
    expect(
      build([], { round: 1, missingFamilies: ["ignored"] }).digest
        .missingFamilies,
    ).toEqual([]);
  });
});
