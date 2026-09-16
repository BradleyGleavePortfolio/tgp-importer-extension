import { compareText } from "./order.js";
import { inferUrlTemplates, URL_HARD_LIMITS } from "./url-templates.js";
// Sanitized vocabulary: diagnostics name a failure class, never an observed value.
const MEMBERSHIP_REASON_CODES = Object.freeze([
  "cluster_missing",
  "cluster_unknown",
  "duplicate_reference",
  "excluded_mismatch",
  "forged_reference",
  "invalid_observations",
  "malformed_membership",
  "membership_unavailable",
  "method_mismatch",
  "observation_limit",
  "origin_mismatch",
  "reference_budget",
  "reference_conflict",
  "reference_out_of_range",
  "stale_observation_count",
  "support_omitted",
]);
const BUDGET = URL_HARD_LIMITS.maxObservations,
  MAX_ORIGIN = 2048,
  MAX_PATTERN = 4096;
// Every membership this module validated, bound to the snapshot positions it
// actually checked. A caller cannot forge the capability, the frozen copy removes
// read-time races, and a snapshot mutated afterwards no longer matches.
const validated = new WeakMap();
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function clusterKey(entry) {
  return JSON.stringify([entry.origin, entry.method, entry.pathPattern]);
}
function clusterShaped(entry) {
  return (
    typeof entry.origin === "string" &&
    entry.origin.length <= MAX_ORIGIN &&
    typeof entry.method === "string" &&
    entry.method.length <= MAX_ORIGIN &&
    typeof entry.pathPattern === "string" &&
    entry.pathPattern.length <= MAX_PATTERN
  );
}
// Length is checked on the caller's array before any copy, so an oversized or
// sparse claim is refused without traversing a single entry.
function boundedRefs(claimed) {
  return Array.isArray(claimed) &&
    claimed.length > 0 &&
    claimed.length <= BUDGET
    ? claimed.length
    : null;
}
function excludedShaped(entry) {
  return (
    isRecord(entry) &&
    Number.isInteger(entry.ref) &&
    typeof entry.reason === "string" &&
    entry.reason.length <= 64
  );
}
function excludedKey(entry) {
  return `${entry.ref}:${entry.reason}`;
}
function differs(left, right) {
  return left.size !== right.size || [...left].some((key) => !right.has(key));
}
function sealed(membership, observations) {
  const positions = Object.freeze([...observations]),
    copy = Object.freeze({
      observationCount: membership.observationCount,
      clusters: Object.freeze(
        membership.clusters.map((entry) =>
          Object.freeze({
            origin: entry.origin,
            method: entry.method,
            pathPattern: entry.pathPattern,
            refs: Object.freeze([...entry.refs]),
          }),
        ),
      ),
      excluded: Object.freeze(
        membership.excluded.map((entry) =>
          Object.freeze({ ref: entry.ref, reason: entry.reason }),
        ),
      ),
    });
  validated.set(copy, { source: observations, positions });
  return copy;
}
function sameSnapshot(binding, observations) {
  return (
    binding !== undefined &&
    binding.source === observations &&
    binding.positions.length === observations.length &&
    binding.positions.every((value, index) => value === observations[index])
  );
}
export function validateObservationMembership(
  observations,
  membership,
  options,
) {
  const reasons = new Set();
  let references = 0;
  const done = (clusters = 0, sealedMembership = null) => ({
    valid: reasons.size === 0,
    reasons: [...reasons].sort(compareText),
    checked: { clusters, references },
    membership: reasons.size === 0 ? sealedMembership : null,
  });
  if (!Array.isArray(observations))
    return (reasons.add("invalid_observations"), done());
  if (observations.length > BUDGET)
    return (reasons.add("observation_limit"), done());
  if (
    !isRecord(membership) ||
    !Array.isArray(membership.clusters) ||
    !Array.isArray(membership.excluded) ||
    membership.clusters.length > BUDGET ||
    membership.excluded.length > BUDGET
  )
    return (reasons.add("malformed_membership"), done());
  if (membership.observationCount !== observations.length)
    return (reasons.add("stale_observation_count"), done());
  // Materialize incrementally, bound first: holes become undefined, accessors are
  // read once, and the aggregate budget aborts before later claims are copied.
  const clusters = [],
    excluded = [];
  for (const entry of Array.from(membership.clusters)) {
    if (!isRecord(entry)) return (reasons.add("malformed_membership"), done());
    const claimed = entry.refs,
      claimedLength = boundedRefs(claimed);
    if (claimedLength === null)
      return (reasons.add("malformed_membership"), done());
    references += claimedLength;
    if (references > BUDGET) return (reasons.add("reference_budget"), done());
    const snapshot = {
      origin: entry.origin,
      method: entry.method,
      pathPattern: entry.pathPattern,
      refs: Array.from(claimed),
    };
    if (!clusterShaped(snapshot))
      return (reasons.add("malformed_membership"), done());
    clusters.push(snapshot);
  }
  for (const entry of Array.from(membership.excluded)) {
    if (!isRecord(entry)) return (reasons.add("malformed_membership"), done());
    const snapshot = { ref: entry.ref, reason: entry.reason };
    if (!excludedShaped(snapshot))
      return (reasons.add("malformed_membership"), done());
    references += 1;
    if (references > BUDGET) return (reasons.add("reference_budget"), done());
    excluded.push(snapshot);
  }
  const owners = new Map();
  for (const entry of clusters) {
    const seen = new Set();
    for (const ref of entry.refs) {
      if (!Number.isInteger(ref) || ref < 0 || ref >= observations.length) {
        reasons.add("reference_out_of_range");
        continue;
      }
      if (seen.has(ref)) reasons.add("duplicate_reference");
      else if (owners.has(ref)) reasons.add("reference_conflict");
      seen.add(ref);
      owners.set(ref, clusterKey(entry));
      const observation = observations[ref];
      if (!isRecord(observation) || observation.origin !== entry.origin)
        reasons.add("origin_mismatch");
      if (!isRecord(observation) || observation.method !== entry.method)
        reasons.add("method_mismatch");
    }
  }
  for (const entry of excluded) {
    if (entry.ref < 0 || entry.ref >= observations.length)
      reasons.add("reference_out_of_range");
    else if (owners.has(entry.ref)) reasons.add("reference_conflict");
    else owners.set(entry.ref, "excluded");
  }
  // Authority is the clustering algorithm itself, never a second path matcher.
  const authoritative = inferUrlTemplates(observations, {
    ...options,
    membership: true,
  }).membership;
  if (!authoritative) return (reasons.add("membership_unavailable"), done());
  const provided = new Map(
    clusters.map((entry) => [clusterKey(entry), entry.refs]),
  );
  if (provided.size !== clusters.length) reasons.add("malformed_membership");
  for (const entry of authoritative.clusters) {
    const key = clusterKey(entry),
      claimed = provided.get(key);
    if (claimed === undefined) {
      reasons.add("cluster_missing");
      continue;
    }
    provided.delete(key);
    const truth = new Set(entry.refs),
      given = new Set(claimed);
    if ([...truth].some((ref) => !given.has(ref)))
      reasons.add("support_omitted");
    if ([...given].some((ref) => !truth.has(ref)))
      reasons.add("forged_reference");
  }
  if (provided.size > 0) reasons.add("cluster_unknown");
  if (
    differs(
      new Set(authoritative.excluded.map(excludedKey)),
      new Set(excluded.map(excludedKey)),
    )
  )
    reasons.add("excluded_mismatch");
  return done(
    clusters.length,
    reasons.size === 0 ? sealed(authoritative, observations) : null,
  );
}
// Consumers join through the validated capability only; unvalidated or
// mismatched snapshots yield null rather than unproven attribution.
export function selectClusterObservations(observations, membership, cluster) {
  if (
    !Array.isArray(observations) ||
    !isRecord(membership) ||
    !isRecord(cluster) ||
    !sameSnapshot(validated.get(membership), observations)
  )
    return null;
  const wanted = clusterKey(cluster),
    entry = membership.clusters.find(
      (candidate) => clusterKey(candidate) === wanted,
    );
  if (!entry) return null;
  return entry.refs.some((ref) => ref >= observations.length)
    ? null
    : Object.freeze(entry.refs.map((ref) => observations[ref]));
}
export { MEMBERSHIP_REASON_CODES };
