// Quarantined legacy oracle (NORTH_STAR.md "What this retires"). Everything the
// extension knows about this one vendor lives under legacy/: its origin match,
// its data-only blueprint, its hand-written extractor and its API base. Core
// reaches it through exactly ONE import of this module (background.js), which
// only registers the oracle with the vendor-free registry in
// shared/replay/resolve.js. The oracle exists to check that the learned path
// matches it and is deleted at the V1 exit; this directory only shrinks.
import { register, registerExtractor } from "../shared/replay/resolve.js";
import { truecoachBlueprint } from "./truecoach/blueprint.js";
import { TrueCoachExtractor } from "./truecoach/extractor.js";
import { PLATFORM } from "./truecoach/parse.js";
import { TRUECOACH_API_BASE } from "./truecoach/api-base.js";

// EXACT origin match on the oracle's API origin (review B, B2). The former
// hostname-suffix match (extractors/detect.js) let a brand subdomain resolve to
// an extractor that then fetched the flagship host, i.e. an origin the coach
// had not authorized. A run is confined to the ONE authorized origin, so the
// oracle answers for exactly the origin it talks to and nothing else.
const ORACLE_ORIGIN = new URL(TRUECOACH_API_BASE).origin;

export function matchesTrueCoachOrigin(origin) {
  return typeof origin === "string" && origin === ORACLE_ORIGIN;
}

register(matchesTrueCoachOrigin, truecoachBlueprint);
registerExtractor(
  matchesTrueCoachOrigin,
  PLATFORM,
  (deps) => new TrueCoachExtractor(deps),
);
