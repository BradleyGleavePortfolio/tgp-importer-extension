import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPORT_STATUS_PATH,
  MAX_STATUS_BODY_BYTES,
  SERVER_STATUSES,
  isSendableIntentId,
  parseImportStatus,
  readImportStatusReply,
} from "../shared/import-status.js";

// Consumer freeze of GET /api/scout/import/status. The fixture is derived from
// the landed backend contract (integration/importer df713fd9,
// docs/contracts/importer-openapi.json 2.0.0-c1-s2.0): its `schemas` are
// verbatim copies and its `responses` are synthetic examples. Every example is
// first proven against the frozen schema, then driven through the consumer.
const fixture = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "test/fixtures/import-status/import-status.fixture.json",
    ),
    "utf8",
  ),
);
const { schemas, responses } = fixture;
const INTENT = "imp-1790000000000";

// Minimal OpenAPI 3 subset validator (the constructs these six schemas use).
function violations(schema, value, path = "$") {
  if (schema.$ref) {
    return violations(schemas[schema.$ref.split("/").at(-1)], value, path);
  }
  if (schema.allOf) {
    return schema.allOf.flatMap((part) => violations(part, value, path));
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(
      (part) => violations(part, value, path).length === 0,
    );
    return matches.length === 1
      ? []
      : [`${path}: oneOf matched ${matches.length}`];
  }
  if (value === null) {
    return schema.nullable === true ? [] : [`${path}: null not allowed`];
  }
  const out = [];
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: enum`);
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || Array.isArray(value))
        return [`${path}: not an object`];
      for (const key of schema.required ?? [])
        if (!Object.hasOwn(value, key)) out.push(`${path}.${key}: missing`);
      for (const [key, child] of Object.entries(value)) {
        const prop = schema.properties?.[key];
        if (!prop) out.push(`${path}.${key}: undeclared`);
        else out.push(...violations(prop, child, `${path}.${key}`));
      }
      return out;
    }
    case "array":
      if (!Array.isArray(value)) return [`${path}: not an array`];
      return value.flatMap((item, index) =>
        violations(schema.items, item, `${path}[${index}]`),
      );
    case "string":
      if (typeof value !== "string") return [`${path}: not a string`];
      if (schema.format === "date-time" && Number.isNaN(Date.parse(value)))
        out.push(`${path}: not a date-time`);
      if (schema.minLength !== undefined && value.length < schema.minLength)
        out.push(`${path}: too short`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        out.push(`${path}: too long`);
      return out;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        return [`${path}: not a number`];
      if (schema.minimum !== undefined && value < schema.minimum)
        out.push(`${path}: below minimum`);
      return out;
    default:
      return out;
  }
}

const successExamples = Object.entries(responses).filter(
  ([, example]) => example.http_status === 200,
);

describe("frozen contract identity and request shape", () => {
  it("pins the landed backend contract the fixture was derived from", () => {
    expect(fixture.contract).toMatchObject({
      ref: "integration/importer",
      commit: "df713fd9217df524915348ef8a42c797f288dde1",
      path: "docs/contracts/importer-openapi.json",
      info_version: "2.0.0-c1-s2.0",
    });
  });

  it("is a bearer GET with exactly one required, 1..128 intent_id query", () => {
    expect(fixture.request.method).toBe("GET");
    expect(fixture.request.path).toBe(IMPORT_STATUS_PATH);
    expect(fixture.request.security).toEqual([{ bearer: [] }]);
    expect(fixture.request.query).toEqual({
      intent_id: {
        in: "query",
        required: true,
        schema: { maxLength: 128, minLength: 1, type: "string" },
      },
    });
    expect(isSendableIntentId("")).toBe(false);
    expect(isSendableIntentId("x")).toBe(true);
    expect(isSendableIntentId("x".repeat(128))).toBe(true);
    expect(isSendableIntentId("x".repeat(129))).toBe(false);
    expect(isSendableIntentId(null)).toBe(false);
    expect(isSendableIntentId(INTENT)).toBe(true);
  });

  it("consumes exactly the frozen status and mode vocabularies", () => {
    const result = schemas.ScoutImportStatusResult.properties;
    expect(SERVER_STATUSES).toEqual(result.status.enum);
    expect(result.mode.enum).toEqual(["legacy", "server"]);
    expect(result.entity_counts.items.$ref).toBe(
      "#/components/schemas/ScoutImportEntityCountDto",
    );
  });

  it.each(Object.entries(responses))(
    "fixture example %s satisfies its frozen schema",
    (_name, example) => {
      const ref = fixture.response_refs[String(example.http_status)];
      expect(ref).toBeTypeOf("string");
      expect(violations(schemas[ref], example.body)).toEqual([]);
    },
  );
});

describe("parseImportStatus over the fixture", () => {
  it.each(successExamples)("%s -> a known reply", (_name, example) => {
    const parsed = parseImportStatus(example.body, INTENT);
    expect(parsed).toEqual({
      state: "known",
      intentId: INTENT,
      status: example.body.status,
      mode: example.body.mode,
      settled: example.body.status !== "running",
      counts: example.body.entity_counts.map((row) => ({
        entityType: row.entity_type,
        committed: row.committed,
      })),
    });
    // The extension's own claim is never carried as the result.
    expect(JSON.stringify(parsed)).not.toContain("claimed");
  });

  it("tolerates an additive, unconsumed field", () => {
    const body = { ...responses.legacy_partial.body, future_field: { a: 1 } };
    expect(parseImportStatus(body, INTENT)?.status).toBe("partial");
  });

  const base = responses.legacy_partial.body;
  it.each([
    ["another run's reply", { ...base, intent_id: "imp-1" }],
    ["unknown status", { ...base, status: "imported" }],
    ["unknown mode", { ...base, mode: "hybrid" }],
    ["non-string completed_at", { ...base, completed_at: 5 }],
    ["missing entity_counts", { ...base, entity_counts: undefined }],
    [
      "negative committed",
      { ...base, entity_counts: [{ entity_type: "clients", committed: -1 }] },
    ],
    [
      "fractional committed",
      { ...base, entity_counts: [{ entity_type: "clients", committed: 1.5 }] },
    ],
    [
      "string committed",
      { ...base, entity_counts: [{ entity_type: "clients", committed: "7" }] },
    ],
    [
      "empty family name",
      { ...base, entity_counts: [{ entity_type: "", committed: 1 }] },
    ],
    [
      "duplicate family",
      {
        ...base,
        entity_counts: [
          { entity_type: "clients", committed: 1 },
          { entity_type: "clients", committed: 2 },
        ],
      },
    ],
    [
      "unbounded family list",
      {
        ...base,
        entity_counts: Array.from({ length: 33 }, (_, i) => ({
          entity_type: `f${i}`,
          committed: 1,
        })),
      },
    ],
    ["array body", [base]],
    ["null body", null],
  ])("rejects %s", (_name, body) => {
    expect(parseImportStatus(body, INTENT)).toBeNull();
  });
});

describe("readImportStatusReply classifies one HTTP reply", () => {
  function reply(example) {
    return new Response(JSON.stringify(example.body), {
      status: example.http_status,
      headers: { "content-type": "application/json" },
    });
  }

  it.each(successExamples)("200 %s -> known", async (_name, example) => {
    const { http, reply: out } = await readImportStatusReply(
      reply(example),
      INTENT,
      null,
    );
    expect(http).toBe(200);
    expect(out.state).toBe("known");
  });

  it("404 (uniform no-evidence / dark route) -> not yet known, never 0", async () => {
    const { http, reply: out } = await readImportStatusReply(
      reply(responses.not_found),
      INTENT,
      null,
    );
    expect(http).toBe(404);
    expect(out).toEqual({ state: "not_yet_known", intentId: INTENT });
  });

  it.each(["bad_request", "unauthorized", "forbidden", "rate_limited"])(
    "%s -> unavailable, error body never surfaced",
    async (name) => {
      const { http, reply: out } = await readImportStatusReply(
        reply(responses[name]),
        INTENT,
        null,
      );
      expect(http).toBe(responses[name].http_status);
      expect(out).toEqual({ state: "unavailable" });
    },
  );

  it.each([
    ["500", new Response("boom", { status: 500 })],
    ["malformed 200", new Response("{not json", { status: 200 })],
    [
      "oversize 200",
      new Response("x".repeat(MAX_STATUS_BODY_BYTES + 1), { status: 200 }),
    ],
    [
      "wrong-shape 200",
      new Response(JSON.stringify({ status: "success" }), { status: 200 }),
    ],
  ])("%s -> unavailable", async (_name, response) => {
    const { reply: out } = await readImportStatusReply(response, INTENT, null);
    expect(out).toEqual({ state: "unavailable" });
  });
});
