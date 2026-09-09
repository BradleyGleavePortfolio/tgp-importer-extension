import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeCaptureSnapshot } from "../shared/blueprint/input.js";
import { inferUrlTemplates } from "../shared/blueprint/url-templates.js";
import { clusterResponseShapes } from "../shared/blueprint/shapes.js";

function loadFixture() {
    const path = fileURLToPath(
        new URL("./fixtures/blueprint/synthetic-truecoach-c2a.json", import.meta.url),
    );
    return JSON.parse(readFileSync(path, "utf8"));
}

describe("synthetic C2a fixture evidence (not a captured oracle)", () => {
    it("normalizes the hand-authored redacted fixture without exclusions", () => {
        const result = normalizeCaptureSnapshot(loadFixture());
        expect(result.excluded).toEqual([]);
        expect(result.observations).toHaveLength(3);
        expect(result.observations.every((item) =>
            item.origin === "https://app.truecoach.co" &&
            item.method === "GET" &&
            item.status === 200)).toBe(true);
    });

    it("clusters client details without collapsing the static /api/v2 segment", () => {
        const normalized = normalizeCaptureSnapshot(loadFixture());
        const result = inferUrlTemplates(normalized.observations);
        expect(result).toEqual({
            clusters: [{
                origin: "https://app.truecoach.co",
                method: "GET",
                pathPattern: "/{s6}/{s4}/v2/{s5}/:id",
                dynamicSegments: 1,
                replayCompatible: true,
                queryKeys: ["page"],
                observations: 3,
            }],
            excluded: [],
        });
    });

    it("produces one key-order-independent response shape cluster", () => {
        const normalized = normalizeCaptureSnapshot(loadFixture());
        const result = clusterResponseShapes(normalized.observations, { maxDepth: 3 });
        expect(result).toEqual([{
            origin: "https://app.truecoach.co",
            method: "GET",
            signature: "object{number*1,object{boolean*1}*1,string*3}",
            observations: 3,
        }]);
    });

    it("emits no captured PII or query values in templates or shape signatures", () => {
        const fixture = loadFixture();
        const normalized = normalizeCaptureSnapshot(fixture);
        const evidence = {
            templates: inferUrlTemplates(normalized.observations),
            shapes: clusterResponseShapes(normalized.observations, { maxDepth: 3 }),
        };
        const serialized = JSON.stringify(evidence);
        for (const forbidden of [
            "Dana Coach",
            "dana@example.com",
            "Sam Lift",
            "sam@example.com",
            "Taylor Strong",
            "taylor@example.com",
            "access_token=<redacted>",
        ]) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    it("produces byte-identical evidence after fixture order is reversed", () => {
        const fixture = loadFixture();
        const produce = (entries) => {
            const normalized = normalizeCaptureSnapshot(entries);
            return JSON.stringify({
                templates: inferUrlTemplates(normalized.observations),
                shapes: clusterResponseShapes(normalized.observations),
            });
        };
        expect(produce(fixture)).toBe(produce([...fixture].reverse()));
    });
});
