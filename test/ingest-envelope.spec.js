import { describe, it, expect } from "vitest";
import { makeEntity } from "../extractors/_interface.js";
import { makeScoutIngestBody } from "../shared/protocol.js";

// R80-CLARIFY-1 (2026-07-07): the executable makeEntity() output is the
// authoritative entity envelope — camelCase, provenance at entity top level:
//   { sourceId, sourcePlatform, capturedAt, payload }
// The outer batch envelope is snake_case (intent_id / entity_type) to match
// the backend ScoutIngestDto, but each entity passes through VERBATIM.
const REQUIRED_ENTITY_KEYS = [
  "sourceId",
  "sourcePlatform",
  "capturedAt",
  "payload",
];

describe("makeEntity — authoritative camelCase entity envelope", () => {
  it("emits all four required camelCase keys and nothing else", () => {
    const entity = makeEntity("auto:app.truecoach.co", 7, {
      kind: "client",
      name: "A",
    });
    expect(Object.keys(entity).sort()).toEqual(
      [...REQUIRED_ENTITY_KEYS].sort(),
    );
  });

  it("stamps provenance at the entity top level, not inside payload", () => {
    const entity = makeEntity("auto:app.truecoach.co", "c-1", { name: "A" });
    expect(entity.sourceId).toBe("c-1");
    expect(entity.sourcePlatform).toBe("auto:app.truecoach.co");
    expect(typeof entity.capturedAt).toBe("string");
    expect(Number.isNaN(Date.parse(entity.capturedAt))).toBe(false);
    expect(entity.payload).toEqual({ name: "A" });
    expect(entity.payload.sourcePlatform).toBeUndefined();
    expect(entity.payload.capturedAt).toBeUndefined();
  });

  it("never emits snake_case aliases", () => {
    const entity = makeEntity("auto:x", 1, {});
    expect(entity).not.toHaveProperty("source_id");
    expect(entity).not.toHaveProperty("source_platform");
    expect(entity).not.toHaveProperty("captured_at");
  });
});

describe("makeScoutIngestBody — batch envelope for /api/scout/ingest", () => {
  it("passes makeEntity() output through verbatim (no re-mapping)", () => {
    const entities = [
      makeEntity("auto:app.truecoach.co", 7, { kind: "client", name: "A" }),
      makeEntity("auto:app.truecoach.co", 8, { kind: "client", name: "B" }),
    ];
    const body = makeScoutIngestBody("ext-123", "client", entities);
    expect(body.entities).toBe(entities);
    expect(body.entities[0]).toBe(entities[0]);
  });

  it("serialized entities[0] carries all four required camelCase keys", () => {
    const wire = JSON.stringify(
      makeScoutIngestBody("ext-123", "client", [
        makeEntity("auto:x", 1, { a: 1 }),
      ]),
    );
    const parsed = JSON.parse(wire);
    for (const key of REQUIRED_ENTITY_KEYS) {
      // Fails loudly if any of the 4 locked keys goes missing (R80-CLARIFY-1).
      expect(parsed.entities[0]).toHaveProperty(key);
    }
    expect(parsed.entities[0]).not.toHaveProperty("source_id");
  });

  it("keeps the OUTER envelope snake_case to match ScoutIngestDto", () => {
    const body = makeScoutIngestBody("ext-123", "client", []);
    expect(body.intent_id).toBe("ext-123");
    expect(body.entity_type).toBe("client");
    expect(body).not.toHaveProperty("intentId");
    expect(body).not.toHaveProperty("entityType");
  });
});
