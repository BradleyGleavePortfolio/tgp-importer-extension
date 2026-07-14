import { describe, it, expect } from "vitest";
import { truecoachBlueprint } from "../extractors/truecoach/blueprint.js";
import { normalizeBlueprint } from "../shared/replay/blueprint.js";
import { TRUECOACH_API_BASE } from "../shared/protocol.js";

// The TrueCoach blueprint is a DATA-ONLY verification adapter: it must contain no
// executable extraction logic, must describe a valid list->paginate->fan-out
// crawl, and must normalize cleanly under the injected tab-origin allowlist. It
// is deliberately a SUBSET of the hand-mapped extractor (proves the generic
// engine drives a real platform); these tests pin its data contract so a later
// edit cannot silently smuggle behavior or an off-origin target into it.

const TRUECOACH_ORIGIN = "https://app.truecoach.co";

function get(bp, stepId) {
    return bp.steps.find((s) => s.id === stepId);
}

describe("truecoachBlueprint — data-only shape", () => {
    it("is a plain data object: no functions anywhere in the tree", () => {
        const bp = truecoachBlueprint();
        const seen = JSON.stringify(bp); // functions would be dropped by JSON
        // Round-tripping through JSON must be lossless -> proves pure data.
        expect(JSON.parse(seen)).toEqual(bp);
    });

    it("declares platform + apiBase from the shared protocol constant", () => {
        const bp = truecoachBlueprint();
        expect(bp.platform).toBe("truecoach");
        expect(bp.apiBase).toBe(TRUECOACH_API_BASE);
        expect(new URL(bp.apiBase).origin).toBe(TRUECOACH_ORIGIN);
    });

    it("paces at ~2 req/s to mirror the verified hand-mapped walk", () => {
        expect(truecoachBlueprint().rateLimitMs).toBe(500);
    });
});

describe("truecoachBlueprint — crawl topology", () => {
    it("lists clients with page pagination and collects their ids", () => {
        const clients = get(truecoachBlueprint(), "clients");
        expect(clients).toBeDefined();
        expect(clients.template.startsWith("/clients")).toBe(true);
        expect(clients.itemsPath).toEqual(["clients"]);
        expect(clients.idField).toBe("id");
        expect(clients.collectAs).toBe("clientIds");
        expect(clients.pagination).toEqual({ style: "page", param: "page", start: 1 });
    });

    it("fans out per-client notes over the collected client ids", () => {
        const notes = get(truecoachBlueprint(), "notes");
        expect(notes).toBeDefined();
        expect(notes.template).toBe("/clients/:id/notes");
        expect(notes.forEach).toBe("clientIds");
        expect(notes.itemsPath).toEqual(["notes"]);
    });

    it("collects the fan-out id set in an EARLIER step than it is consumed", () => {
        const bp = truecoachBlueprint();
        const collectIdx = bp.steps.findIndex((s) => s.collectAs === "clientIds");
        const forEachIdx = bp.steps.findIndex((s) => s.forEach === "clientIds");
        expect(collectIdx).toBeGreaterThanOrEqual(0);
        expect(forEachIdx).toBeGreaterThan(collectIdx);
    });

    it("uses only safe methods (GET by default, never a mutating verb)", () => {
        for (const step of truecoachBlueprint().steps) {
            const method = step.method ?? "GET";
            expect(["GET", "HEAD"]).toContain(method);
        }
    });

    it("uses only root-relative templates (no off-origin redirect)", () => {
        for (const step of truecoachBlueprint().steps) {
            expect(step.template.startsWith("/")).toBe(true);
            expect(step.template.startsWith("//")).toBe(false);
        }
    });
});

describe("truecoachBlueprint — normalizes under the injected tab-origin allowlist", () => {
    it("passes normalization when the tab origin covers apiBase", () => {
        const norm = normalizeBlueprint(truecoachBlueprint(), { allowedOrigins: [TRUECOACH_ORIGIN] });
        expect(norm.platform).toBe("truecoach");
        expect(norm.apiBase).toBe(TRUECOACH_API_BASE);
        expect(norm.steps).toHaveLength(2);
        // Fan-out edge survives normalization intact.
        expect(norm.steps[1].forEach).toBe("clientIds");
    });

    it("fails closed with no allowlist (site-agnostic core refuses to guess)", () => {
        expect(() => normalizeBlueprint(truecoachBlueprint(), {})).toThrow(/allowedOrigins/);
    });

    it("fails closed when the injected origin is an unrelated site", () => {
        expect(() => normalizeBlueprint(truecoachBlueprint(), { allowedOrigins: ["https://app.trainerize.com"] }))
            .toThrow(/allowed-origins/);
    });
});
