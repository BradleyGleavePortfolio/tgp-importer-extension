// Platform -> declarative PlatformBlueprint resolver. This is the ONLY
// site-specific seam in the replay path: it maps a detected platform id to a
// data-only blueprint the SITE-AGNOSTIC engine (shared/replay/engine.js)
// consumes. The engine itself carries no competitor knowledge; that knowledge
// lives entirely in the data blueprint this resolver hands back.
//
// Every platform without a registered blueprint fails closed with
// UnknownPlatformError ("unknown_platform"): the crawl never starts against a
// platform we cannot describe. PR-C2 replaces this static registry with runtime
// blueprint inference, so an unknown platform is learned from passive capture
// rather than refused — until then, refusing is the safe default.
//
// The registry stores blueprint FACTORIES (not shared objects) so each run gets
// a fresh, independently-mutable blueprint and two concurrent resolutions can
// never alias the same steps array.
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
