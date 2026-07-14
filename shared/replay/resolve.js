// Platform -> declarative PlatformBlueprint resolver: the ONLY site-specific seam
// in the replay path. It maps a detected platform id to a data-only blueprint the
// SITE-AGNOSTIC engine consumes; all competitor knowledge lives in that data, not
// the engine. An unregistered platform fails closed with UnknownPlatformError (the
// crawl never starts against a platform we cannot describe). The registry stores
// blueprint FACTORIES so each run gets a fresh, independently-mutable blueprint.
import { truecoachBlueprint } from "../../extractors/truecoach/blueprint.js";

export class UnknownPlatformError extends Error {
    constructor(platform) {
        super("unknown_platform");
        this.name = "UnknownPlatformError";
        this.platform = typeof platform === "string" ? platform : null;
    }
}

export function isUnknownPlatform(err) {
    return err instanceof Error && err.name === "UnknownPlatformError";
}

const REGISTRY = new Map([
    ["truecoach", truecoachBlueprint],
]);

// Resolve a platform id to a fresh blueprint, or throw UnknownPlatformError.
export function resolveBlueprint(platform) {
    const factory = REGISTRY.get(platform);
    if (factory === undefined) {
        throw new UnknownPlatformError(platform);
    }
    return factory();
}
