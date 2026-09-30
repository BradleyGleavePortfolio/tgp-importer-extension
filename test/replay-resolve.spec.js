import { describe, it, expect } from "vitest";
import {
  register,
  registerExtractor,
  resolveBlueprint,
  resolveExtractor,
  isUnknownPlatform,
  UnknownPlatformError,
} from "../shared/replay/resolve.js";
import { normalizeBlueprint } from "../shared/replay/blueprint.js";
// Importing the quarantined oracle registers it, exactly as background.js does.
import { matchesTrueCoachOrigin } from "../legacy/index.js";

// The registry is the ONLY site-specific seam in the replay path and it is
// vendor-free: an ORIGIN is looked up against registered origin matchers and
// every unregistered origin fails closed. These tests pin (1) resolution of a
// registered origin to a normalizable blueprint confined to that origin, (2)
// per-call freshness so concurrent runs never alias one steps array, (3) the
// fail-closed unknown-origin contract the learning chain later replaces, and
// (4) that the extractor binding is a registry lookup too.

const TRUECOACH_ORIGIN = "https://app.truecoach.co";

describe("resolveBlueprint — registered origin", () => {
  it("returns the oracle's blueprint for its flagship https origin", () => {
    const bp = resolveBlueprint(TRUECOACH_ORIGIN);
    expect(bp.platform).toBe("truecoach");
    expect(bp.apiBase).toBe("https://app.truecoach.co/proxy/api");
    expect(Array.isArray(bp.steps)).toBe(true);
    expect(bp.steps.length).toBeGreaterThanOrEqual(1);
  });

  it("matches exactly the oracle's API origin: no subdomain, scheme, port or look-alike (review B, B2)", () => {
    // The oracle fetches ONE origin, so it may answer for exactly that origin.
    // A brand subdomain used to resolve here and then fetch the flagship
    // host — an origin the coach had not authorized.
    expect(matchesTrueCoachOrigin(TRUECOACH_ORIGIN)).toBe(true);
    expect(matchesTrueCoachOrigin("https://brand.truecoach.co")).toBe(false);
    expect(matchesTrueCoachOrigin("https://truecoach.co")).toBe(false);
    expect(matchesTrueCoachOrigin("https://app.truecoach.co:8443")).toBe(false);
    expect(matchesTrueCoachOrigin("http://app.truecoach.co")).toBe(false);
    expect(
      matchesTrueCoachOrigin("https://app.truecoach.co.evil.example"),
    ).toBe(false);
    expect(matchesTrueCoachOrigin("https://nottruecoach.co")).toBe(false);
    expect(matchesTrueCoachOrigin("not a url")).toBe(false);
    expect(matchesTrueCoachOrigin(undefined)).toBe(false);
  });

  it("a brand subdomain is not learned: blueprint throws UnknownPlatformError, extractor is null", () => {
    expect(() => resolveBlueprint("https://brand.truecoach.co")).toThrow(
      UnknownPlatformError,
    );
    expect(resolveExtractor("https://brand.truecoach.co", {})).toBeNull();
  });

  it("returns a blueprint that normalizes cleanly under the authorized-origin allowlist", () => {
    const bp = resolveBlueprint(TRUECOACH_ORIGIN);
    // The run's authorized origin is what background.js injects; the apiBase
    // origin must be on it, and every step must be structurally valid.
    expect(() =>
      normalizeBlueprint(bp, { allowedOrigins: [TRUECOACH_ORIGIN] }),
    ).not.toThrow();
  });

  it("fails closed at normalization when the authorized origin does not cover apiBase", () => {
    const bp = resolveBlueprint(TRUECOACH_ORIGIN);
    expect(() =>
      normalizeBlueprint(bp, { allowedOrigins: ["https://evil.example.com"] }),
    ).toThrow(/allowed-origins/);
  });

  it("hands back a FRESH blueprint each call (no shared mutable state)", () => {
    const a = resolveBlueprint(TRUECOACH_ORIGIN);
    const b = resolveBlueprint(TRUECOACH_ORIGIN);
    expect(a).not.toBe(b);
    expect(a.steps).not.toBe(b.steps);
    // Mutating one must not leak into the other.
    a.steps.push({ id: "injected" });
    expect(b.steps.some((s) => s.id === "injected")).toBe(false);
  });
});

describe("resolveBlueprint — unknown origin fails closed", () => {
  it("throws UnknownPlatformError for an origin nobody registered", () => {
    expect(() => resolveBlueprint("https://example.com")).toThrow(
      UnknownPlatformError,
    );
  });

  it("carries the offending origin and matches isUnknownPlatform", () => {
    try {
      resolveBlueprint("https://unlearned.example");
      throw new Error("should have thrown");
    } catch (err) {
      expect(isUnknownPlatform(err)).toBe(true);
      expect(err.message).toBe("unknown_platform");
      expect(err.origin).toBe("https://unlearned.example");
    }
  });

  it("throws for null / undefined / non-string / empty ids too", () => {
    expect(() => resolveBlueprint(null)).toThrow(UnknownPlatformError);
    expect(() => resolveBlueprint(undefined)).toThrow(UnknownPlatformError);
    expect(() => resolveBlueprint(42)).toThrow(UnknownPlatformError);
    expect(() => resolveBlueprint("")).toThrow(UnknownPlatformError);
  });
});

describe("register / registerExtractor — vendor-free registration contract", () => {
  it("rejects a non-function matcher or factory before touching the registry", () => {
    expect(() => register("truecoach", () => ({}))).toThrow(TypeError);
    expect(() => register(() => true, "not a factory")).toThrow(TypeError);
    expect(() => registerExtractor(() => true, "p", null)).toThrow(TypeError);
    expect(() =>
      registerExtractor(
        () => true,
        7,
        () => ({}),
      ),
    ).toThrow(TypeError);
  });

  it("resolves a matcher-registered origin and only that origin", () => {
    const origin = "https://learned.example";
    register(
      (candidate) => candidate === origin,
      () => ({ platform: "learned", apiBase: `${origin}/api`, steps: [] }),
    );
    expect(resolveBlueprint(origin).platform).toBe("learned");
    expect(() => resolveBlueprint("https://learned.example.evil")).toThrow(
      UnknownPlatformError,
    );
  });

  it("resolveExtractor is a registry lookup that fails closed with null", () => {
    const deps = {
      sendEntities: async () => undefined,
      broadcastStatus: () => undefined,
    };
    const hit = resolveExtractor(TRUECOACH_ORIGIN, deps);
    expect(hit?.platform).toBe("truecoach");
    expect(typeof hit?.extractor.run).toBe("function");
    expect(resolveExtractor("https://example.com", deps)).toBeNull();
    expect(resolveExtractor(null, deps)).toBeNull();
  });

  it("a matcher that throws never matches: the origin is unknown, not a resolve failure (review B, C4)", () => {
    const poison = "https://poison.example";
    const throwing = (candidate) => {
      if (candidate === poison) throw new Error("matcher bug");
      return false;
    };
    register(throwing, () => ({ platform: "p", apiBase: poison, steps: [] }));
    registerExtractor(throwing, "p", () => ({ run: async () => undefined }));
    expect(() => resolveBlueprint(poison)).toThrow(UnknownPlatformError);
    expect(resolveExtractor(poison, {})).toBeNull();
    // Registrants after the faulty one are still consulted.
    register(
      (candidate) => candidate === poison,
      () => ({ platform: "after", apiBase: poison, steps: [] }),
    );
    expect(resolveBlueprint(poison).platform).toBe("after");
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
