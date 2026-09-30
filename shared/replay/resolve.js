// Origin -> PlatformBlueprint registry: the ONLY site-specific seam in the
// replay path, and it is vendor-free. Core knows no hostnames; a source
// registers an ORIGIN MATCHER and a FACTORY (each run gets a fresh blueprint).
// The oracle under legacy/ is today's only registrant. An origin nobody
// registered fails closed with UnknownPlatformError.

export class UnknownPlatformError extends Error {
  constructor(origin) {
    super("unknown_platform");
    this.name = "UnknownPlatformError";
    this.origin = typeof origin === "string" ? origin : null;
  }
}

export function isUnknownPlatform(err) {
  return err instanceof Error && err.name === "UnknownPlatformError";
}

/** @type {{ matches: (origin: string) => boolean, factory: () => object }[]} */
const BLUEPRINTS = [];
/** @type {{ matches: (origin: string) => boolean, platform: string, factory: (deps: object) => object }[]} */
const EXTRACTORS = [];

function assertMatcher(originMatcher) {
  if (typeof originMatcher !== "function") {
    throw new TypeError("register: originMatcher must be a function");
  }
}

// Register a blueprint factory for every origin `originMatcher` accepts.
export function register(originMatcher, factory) {
  assertMatcher(originMatcher);
  if (typeof factory !== "function") {
    throw new TypeError("register: factory must be a function");
  }
  BLUEPRINTS.push({ matches: originMatcher, factory });
}

// Register a hand-written extractor (legacy oracle) for the origins
// `originMatcher` accepts; `platform` is the provenance id its entities carry.
export function registerExtractor(originMatcher, platform, factory) {
  assertMatcher(originMatcher);
  if (typeof platform !== "string" || typeof factory !== "function") {
    throw new TypeError("registerExtractor: platform and factory required");
  }
  EXTRACTORS.push({ matches: originMatcher, platform, factory });
}

function lookup(entries, origin) {
  if (typeof origin !== "string" || origin.length === 0) {
    return undefined;
  }
  // A matcher that throws never matches: the origin fails closed as unknown
  // instead of surfacing a registrant's fault as a resolve failure.
  return entries.find((entry) => {
    try {
      return entry.matches(origin) === true;
    } catch {
      return false;
    }
  });
}

// Resolve an https origin to a fresh blueprint, or throw UnknownPlatformError.
export function resolveBlueprint(origin) {
  const entry = lookup(BLUEPRINTS, origin);
  if (entry === undefined) {
    throw new UnknownPlatformError(origin);
  }
  return entry.factory();
}

// Resolve an https origin to `{ platform, extractor }`, or null when no
// extractor is registered for it (the caller fails closed).
export function resolveExtractor(origin, deps) {
  const entry = lookup(EXTRACTORS, origin);
  if (entry === undefined) {
    return null;
  }
  return { platform: entry.platform, extractor: entry.factory(deps) };
}
