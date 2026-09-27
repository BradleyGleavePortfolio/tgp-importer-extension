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

// Hostname SUFFIX match (formerly extractors/detect.js) so cosmetic white-label
// brand subdomains resolve to the same oracle as the flagship host. Only an
// https origin ever reaches the registry; a malformed origin never matches.
const HOST_SUFFIX = "truecoach.co";

export function matchesTrueCoachOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    (hostname === HOST_SUFFIX || hostname.endsWith(`.${HOST_SUFFIX}`))
  );
}

register(matchesTrueCoachOrigin, truecoachBlueprint);
registerExtractor(
  matchesTrueCoachOrigin,
  PLATFORM,
  (deps) => new TrueCoachExtractor(deps),
);
