import { describe, it, expect } from "vitest";
import {
    resolveBlueprint,
    isUnknownPlatform,
    UnknownPlatformError,
} from "../shared/replay/resolve.js";
import { normalizeBlueprint } from "../shared/replay/blueprint.js";

// The resolver is the ONLY site-specific seam in the replay path: platform id ->
// data-only blueprint, with every unregistered platform failing closed. These
// tests pin (1) known-platform resolution to a normalizable blueprint, (2)
// per-call freshness so concurrent runs never alias one steps array, and (3)
// the fail-closed unknown-platform contract that PR-C2 later replaces with
// inference.

const TRUECOACH_ORIGIN = "https://app.truecoach.co";

describe("resolveBlueprint — known platform", () => {
    it("returns a TrueCoach blueprint for the 'truecoach' id", () => {
        const bp = resolveBlueprint("truecoach");
        expect(bp.platform).toBe("truecoach");
        expect(bp.apiBase).toBe("https://app.truecoach.co/proxy/api");
        expect(Array.isArray(bp.steps)).toBe(true);
        expect(bp.steps.length).toBeGreaterThanOrEqual(1);
    });

    it("returns a blueprint that normalizes cleanly under the tab-origin allowlist", () => {
        const bp = resolveBlueprint("truecoach");
        // The observed tab origin is what background.js injects; the apiBase
        // origin must be on it, and every step must be structurally valid.
        expect(() => normalizeBlueprint(bp, { allowedOrigins: [TRUECOACH_ORIGIN] })).not.toThrow();
    });

    it("fails closed at normalization when the tab origin does not cover apiBase", () => {
        const bp = resolveBlueprint("truecoach");
        expect(() => normalizeBlueprint(bp, { allowedOrigins: ["https://evil.example.com"] }))
            .toThrow(/allowed-origins/);
    });

    it("hands back a FRESH blueprint each call (no shared mutable state)", () => {
        const a = resolveBlueprint("truecoach");
        const b = resolveBlueprint("truecoach");
        expect(a).not.toBe(b);
        expect(a.steps).not.toBe(b.steps);
        // Mutating one must not leak into the other.
        a.steps.push({ id: "injected" });
        expect(b.steps.some((s) => s.id === "injected")).toBe(false);
    });
});

describe("resolveBlueprint — unknown platform fails closed", () => {
    it("throws UnknownPlatformError for an unregistered platform id", () => {
        expect(() => resolveBlueprint("trainerize")).toThrow(UnknownPlatformError);
    });

    it("carries the offending platform id and matches isUnknownPlatform", () => {
        try {
            resolveBlueprint("mypthub");
            throw new Error("should have thrown");
        }
        catch (err) {
            expect(isUnknownPlatform(err)).toBe(true);
            expect(err.message).toBe("unknown_platform");
            expect(err.platform).toBe("mypthub");
        }
    });

    it("throws for null / undefined / non-string ids too", () => {
        expect(() => resolveBlueprint(null)).toThrow(UnknownPlatformError);
        expect(() => resolveBlueprint(undefined)).toThrow(UnknownPlatformError);
        expect(() => resolveBlueprint(42)).toThrow(UnknownPlatformError);
    });
});

describe("isUnknownPlatform predicate", () => {
    it("only matches its own error type", () => {
        expect(isUnknownPlatform(new UnknownPlatformError("x"))).toBe(true);
        expect(isUnknownPlatform(new Error("unknown_platform"))).toBe(false);
        expect(isUnknownPlatform(null)).toBe(false);
        expect(isUnknownPlatform("unknown_platform")).toBe(false);
    });
});
