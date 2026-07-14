import { describe, it, expect } from "vitest";
import {
    isStartIngest,
    isBearerFound,
    isRequestStatus,
    makeScoutIngestBody,
    PAIR_REDEEM_PATH,
    TRUECOACH_API_BASE,
    TGP_API_ORIGIN,
} from "../shared/protocol.js";

// Coverage of shared/protocol.js — the shared message narrowing helpers and the
// scout-ingest envelope builder. These run on every untyped chrome.runtime
// payload, so the contract that matters is: they narrow strictly (right kind,
// real object) and never throw on hostile/degenerate input, and the envelope
// keeps its snake_case outer shape while passing entities through untouched.

describe("message narrowing helpers", () => {
    it("accept only the matching kind on a real object", () => {
        expect(isStartIngest({ kind: "start_ingest", url: "x" })).toBe(true);
        expect(isBearerFound({ kind: "bearer_found" })).toBe(true);
        expect(isRequestStatus({ kind: "request_status" })).toBe(true);
    });

    it("reject a mismatched kind", () => {
        expect(isStartIngest({ kind: "bearer_found" })).toBe(false);
        expect(isBearerFound({ kind: "request_status" })).toBe(false);
        expect(isRequestStatus({ kind: "start_ingest" })).toBe(false);
    });

    it("never throw on degenerate / hostile input", () => {
        for (const bad of [null, undefined, 42, "start_ingest", [], () => {}]) {
            expect(isStartIngest(bad)).toBe(false);
            expect(isBearerFound(bad)).toBe(false);
            expect(isRequestStatus(bad)).toBe(false);
        }
    });
});

describe("makeScoutIngestBody", () => {
    it("wraps entities in the snake_case backend envelope", () => {
        const entities = [{ sourceId: "1", sourcePlatform: "truecoach", capturedAt: "t", payload: {} }];
        const body = makeScoutIngestBody("intent-1", "client", entities);
        expect(body).toEqual({ intent_id: "intent-1", entity_type: "client", entities });
    });

    it("passes entities through by reference — no remap, no clone", () => {
        const entities = [{ sourceId: "x" }];
        const body = makeScoutIngestBody("i", "workout", entities);
        // R80-CLARIFY-1: entities must be the untouched makeEntity() output.
        expect(body.entities).toBe(entities);
    });

    it("preserves an empty batch as an empty entities array", () => {
        expect(makeScoutIngestBody("i", "client", [])).toEqual({
            intent_id: "i",
            entity_type: "client",
            entities: [],
        });
    });
});

describe("config constants", () => {
    it("point at the expected TGP + TrueCoach origins", () => {
        expect(TGP_API_ORIGIN).toBe("https://api.tgp.coach");
        expect(PAIR_REDEEM_PATH).toBe("/api/extension/pair/redeem");
        expect(TRUECOACH_API_BASE).toBe("https://app.truecoach.co/proxy/api");
    });
});
