import { compareText } from "./order.js";
import {
  record,
  data,
  arrayLength,
  indices,
  observationRows,
  inferenceOptions,
  URL_TEXT_LIMITS,
} from "./snapshot.js";
import { inferUrlTemplates, URL_HARD_LIMITS } from "./url-templates.js";
// Sanitized vocabulary: diagnostics name a failure class, never an observed value.
const MEMBERSHIP_REASON_CODES = Object.freeze([
  "cluster_missing",
  "cluster_unknown",
  "duplicate_reference",
  "excluded_mismatch",
  "forged_reference",
  "invalid_observation",
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
const BUDGET = URL_HARD_LIMITS.maxObservations;
const validated = new WeakMap();
function clusterFields(entry) {
  if (!record(entry)) throw new TypeError("non_record");
  const copy = { origin: "", method: "", pathPattern: "" };
  for (const key of ["origin", "method", "pathPattern"]) {
    const value = data(entry, key, true);
    if (typeof value !== "string" || value.length > URL_TEXT_LIMITS[key])
      throw new TypeError("invalid_key");
    copy[key] = value;
  }
  return copy;
}
function clusterKey(entry) {
  return JSON.stringify([entry.origin, entry.method, entry.pathPattern]);
}
function excludedKey(entry) {
  return `${entry.ref}:${entry.reason}`;
}
function differs(left, right) {
  return left.size !== right.size || [...left].some((key) => !right.has(key));
}
function sealed(membership, source, positions) {
  for (const entry of membership.clusters) {
    Object.freeze(entry.refs);
    Object.freeze(entry);
  }
  membership.excluded.forEach(Object.freeze);
  Object.freeze(membership.clusters);
  Object.freeze(membership.excluded);
  Object.freeze(membership);
  validated.set(membership, { source, positions: Object.freeze(positions) });
  return membership;
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
  let failure = "invalid_observations";
  try {
    const length = arrayLength(observations);
    if (length > BUDGET) return (reasons.add("observation_limit"), done());
    const positions = indices(observations, length, true),
      rows = observationRows(positions),
      settings = inferenceOptions(options);
    settings.membership = true;
    failure = "malformed_membership";
    if (membership === undefined) {
      reasons.add(
        inferUrlTemplates(rows, settings).membership
          ? "malformed_membership"
          : "membership_unavailable",
      );
      return done();
    }
    if (!record(membership)) return (reasons.add(failure), done());
    const count = data(membership, "observationCount", true),
      claimedClusters = data(membership, "clusters", true),
      claimedExcluded = data(membership, "excluded", true),
      clusterCount = arrayLength(claimedClusters),
      excludedCount = arrayLength(claimedExcluded);
    if (clusterCount > BUDGET || excludedCount > BUDGET)
      return (reasons.add(failure), done());
    if (count !== length)
      return (reasons.add("stale_observation_count"), done());
    const clusters = [],
      excluded = [];
    for (let index = 0; index < clusterCount; index++) {
      const entry = data(claimedClusters, index, true),
        claimed = data(entry, "refs", true),
        claimedLength = arrayLength(claimed);
      if (claimedLength === 0 || claimedLength > BUDGET)
        return (reasons.add(failure), done());
      references += claimedLength;
      if (references > BUDGET) return (reasons.add("reference_budget"), done());
      clusters.push({
        ...clusterFields(entry),
        refs: indices(claimed, claimedLength),
      });
    }
    for (let index = 0; index < excludedCount; index++) {
      references++;
      if (references > BUDGET) return (reasons.add("reference_budget"), done());
      const entry = data(claimedExcluded, index, true);
      if (!record(entry)) return (reasons.add(failure), done());
      const ref = data(entry, "ref", true),
        reason = data(entry, "reason", true);
      if (
        !Number.isInteger(ref) ||
        typeof reason !== "string" ||
        reason.length > 64
      )
        return (reasons.add(failure), done());
      excluded.push({ ref, reason });
    }
    const owners = new Map();
    for (const entry of clusters) {
      const seen = new Set();
      for (const ref of entry.refs) {
        if (!Number.isInteger(ref) || ref < 0 || ref >= length) {
          reasons.add("reference_out_of_range");
          continue;
        }
        if (seen.has(ref)) reasons.add("duplicate_reference");
        else if (owners.has(ref)) reasons.add("reference_conflict");
        seen.add(ref);
        owners.set(ref, clusterKey(entry));
        const observation = rows[ref];
        if (observation === null || observation === undefined) {
          reasons.add("invalid_observation");
          continue;
        }
        if (observation.origin !== entry.origin) reasons.add("origin_mismatch");
        if (observation.method !== entry.method) reasons.add("method_mismatch");
      }
    }
    for (const entry of excluded) {
      if (entry.ref < 0 || entry.ref >= length)
        reasons.add("reference_out_of_range");
      else if (owners.has(entry.ref)) reasons.add("reference_conflict");
      else owners.set(entry.ref, "excluded");
    }
    // Authority is the clustering algorithm itself, never a second path matcher.
    const authoritative = inferUrlTemplates(rows, settings).membership;
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
      reasons.size === 0
        ? sealed(authoritative, observations, positions)
        : null,
    );
  } catch {
    return (reasons.add(failure), done());
  }
}
// Consumers join through the validated capability only; unvalidated or
// mismatched snapshots yield null rather than unproven attribution.
export function selectClusterObservations(observations, membership, cluster) {
  try {
    const wanted = clusterKey(clusterFields(cluster)),
      binding = validated.get(membership);
    if (!binding || binding.source !== observations) return null;
    const length = arrayLength(observations);
    if (length !== binding.positions.length) return null;
    const positions = indices(observations, length, true);
    if (positions.some((value, index) => value !== binding.positions[index]))
      return null;
    const entry = membership.clusters.find(
      (candidate) => clusterKey(candidate) === wanted,
    );
    return entry
      ? Object.freeze(entry.refs.map((ref) => positions[ref]))
      : null;
  } catch {
    return null;
  }
}
export { MEMBERSHIP_REASON_CODES };
