// Endpoint-role candidate inference (C2b) — pure, bounded, deterministic and
// site-agnostic. It joins normalized C2a observations to URL-template clusters
// and reports STRUCTURAL evidence only: collection vs single entity vs neither,
// plus window/pagination hints from supported query NAMES. It never emits a
// runnable blueprint, confidence score, id field, edge, or pagination
// descriptor; ambiguity always fails closed into `refused`. Output carries only
// origin, method, template pattern, conservative structural path keys, C2a shape
// signatures (which omit property names), query names, and counts — never
// response values, ids, query values, headers, timestamps, or bodies.
import { isCredentialKey } from "../credential-policy.js";
import { compareText } from "./order.js";
import { shapeSignature } from "./shapes.js";
import { candidateKind, SUPPORTED_QUERY_KEYS } from "./url-templates.js";
const HARD = Object.freeze({
    maxObservations: 1000,
    maxDepth: 4,
    maxCandidateArrays: 16,
  }),
  SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/,
  PROTOTYPE_KEY = /^(?:__proto__|prototype|constructor)$/;
const WINDOW_PAIRS = [
    ["from", "to"],
    ["since", "until"],
    ["start", "end"],
  ],
  PAGINATION_KEYS = new Set(["cursor", "limit", "offset", "page", "per_page"]),
  CURSOR_HINTS = ["after", "before"],
  CONTACT_LITERAL = /@|\+?\d[\d ()-]{5,}\d/;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function option(options, key) {
  const raw = options?.[key];
  return Number.isInteger(raw) && raw >= 1
    ? Math.min(raw, HARD[key])
    : HARD[key];
}
function safePathKey(key) {
  return (
    SAFE_KEY.test(key) && !PROTOTYPE_KEY.test(key) && !isCredentialKey(key)
  );
}
function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw).normalize("NFC");
  } catch {
    return null;
  }
}
// Specificity of a template for a concrete path: matched literal segments, or
// -1 when the template does not describe the path. A `:id` position must hold a
// value C2a itself recognizes, so the join never reads a template more loosely
// than the clusterer wrote it.
function matchScore(pattern, path) {
  if (typeof pattern !== "string" || typeof path !== "string") return -1;
  const wanted = pattern.split("/"),
    actual = path.split("/");
  if (wanted.length !== actual.length) return -1;
  let score = 0;
  for (let index = 0; index < wanted.length; index += 1) {
    const observed = decodeSegment(actual[index]);
    if (observed === null) return -1;
    if (wanted[index] === ":id") {
      if (candidateKind(observed) === null) return -1;
    } else if (decodeSegment(wanted[index]) !== observed) return -1;
    else score += 1;
  }
  return score;
}
// A template literal is upstream data, not a proven-safe name: a contact-like
// segment (an address form, or a long digit run such as a phone or account
// number) must never be echoed, so such an endpoint is refused without its
// template. Double decoding is deliberate — an encoded "%2540" hides an "@".
function safeTemplateLiteral(pattern) {
  return pattern
    .split("/")
    .filter((segment) => segment !== "" && segment !== ":id")
    .every((segment) => {
      const once = decodeSegment(segment),
        twice = once === null ? null : decodeSegment(once);
      return (
        once !== null &&
        twice !== null &&
        ![once, twice].some((value) => CONTACT_LITERAL.test(value))
      );
    });
}
function validCluster(cluster) {
  return (
    isRecord(cluster) &&
    typeof cluster.origin === "string" &&
    ["GET", "HEAD"].includes(cluster.method) &&
    typeof cluster.pathPattern === "string" &&
    cluster.pathPattern.startsWith("/")
  );
}
function endpointOf(cluster) {
  return {
    origin: cluster.origin,
    method: cluster.method,
    template: cluster.pathPattern,
  };
}
// Bounded key-sorted walk collecting every array within maxDepth object keys.
// A branch stops at its first array (an array inside an array is item structure,
// not a container path); an unsafe key aborts the endpoint instead of leaking.
function collectArrays(body, limits) {
  const found = [];
  let unsafe = false;
  const walk = (node, path) => {
    if (found.length > limits.maxCandidateArrays) return;
    if (Array.isArray(node)) return void found.push({ path, items: node });
    if (!isRecord(node) || path.length >= limits.maxDepth) return;
    for (const key of Object.keys(node).sort(compareText))
      if (safePathKey(key)) walk(node[key], [...path, key]);
      else unsafe = true;
  };
  walk(body, []);
  return { found, unsafe };
}
// Structural reading of ONE body: list (exactly one non-empty array of uniformly
// shaped objects), empty collection, singleton object, scalar/null, or refusal.
function classifyBody(body, limits) {
  if (!isRecord(body) && !Array.isArray(body)) return { kind: "scalar" };
  const { found, unsafe } = collectArrays(body, limits);
  if (found.length > limits.maxCandidateArrays)
    return { kind: "refused", reason: "candidate_array_limit" };
  if (unsafe) return { kind: "refused", reason: "unsafe_path_key" };
  const entity = [],
    empty = [];
  for (const { path, items } of found) {
    if (items.length === 0) {
      empty.push(path);
      continue;
    }
    const variants = [
      ...new Set(
        items.map((item) => (isRecord(item) ? shapeSignature(item) : "scalar")),
      ),
    ];
    if (variants.length !== 1)
      return { kind: "refused", reason: "inconsistent_item_shape" };
    if (variants[0] !== "scalar") entity.push({ path, itemShape: variants[0] });
  }
  if (entity.length > 1 || (entity.length === 0 && empty.length > 1))
    return { kind: "refused", reason: "ambiguous_items_path" };
  if (entity.length === 1)
    return { kind: "list", itemsPath: entity[0].path, ...entity[0] };
  if (empty.length === 1)
    return { kind: "empty", itemsPath: empty[0], itemShape: null };
  return isRecord(body)
    ? { kind: "singleton", itemsPath: null, itemShape: shapeSignature(body) }
    : { kind: "scalar" };
}
function windowEvidence(keySets) {
  const pairs = new Set();
  for (const keys of keySets)
    for (const [lower, upper] of WINDOW_PAIRS)
      if (keys.has(lower) && keys.has(upper)) pairs.add(`${lower}:${upper}`);
  if (pairs.size !== 1) return { evidence: null, ambiguous: pairs.size > 1 };
  const [lower, upper] = [...pairs][0].split(":");
  return { evidence: { lower, upper }, ambiguous: false };
}
function paginationEvidence(keySets) {
  const keys = new Set(keySets.flatMap((set) => [...set])),
    styles = [];
  if (keys.has("page") || keys.has("offset")) styles.push("page");
  if (keys.has("cursor")) styles.push("cursor");
  if (styles.length === 0)
    return {
      evidence: null,
      ambiguous: CURSOR_HINTS.some((name) => keys.has(name)),
    };
  return {
    evidence: {
      styles: styles.sort(compareText),
      queryKeys: [...keys]
        .filter((key) => PAGINATION_KEYS.has(key))
        .sort(compareText),
    },
    ambiguous: false,
  };
}
function supportedKeySet(observation) {
  const keys = Array.isArray(observation.queryKeys)
    ? observation.queryKeys
    : [];
  return new Set(
    keys
      .filter((key) => typeof key === "string")
      .map((key) => key.toLowerCase())
      .filter((key) => SUPPORTED_QUERY_KEYS.has(key)),
  );
}
// Only a successful GET body votes: HEAD corroborates existence but carries no
// entity evidence, and a non-2xx body describes an error, not the resource. An
// absent status is unknown rather than a failure, so it still votes.
function votes({ method, status }) {
  return (
    method === "GET" &&
    (status === null ||
      status === undefined ||
      (Number.isInteger(status) && status >= 200 && status < 300))
  );
}
function candidateFor(cluster, voting, limits) {
  const endpoint = endpointOf(cluster),
    support = voting.length,
    deny = (reason) => ({ endpoint, reason, support });
  if (support === 0) return deny("no_successful_get_evidence");
  const readings = voting.map((observation) =>
      classifyBody(observation.body, limits),
    ),
    refusal = readings
      .filter((reading) => reading.kind === "refused")
      .map((reading) => reading.reason)
      .sort(compareText)[0],
    kinds = new Set(readings.map((reading) => reading.kind)),
    shapes = new Set(
      readings
        .filter((reading) => typeof reading.itemShape === "string")
        .map((reading) => reading.itemShape),
    );
  if (refusal) return deny(refusal);
  if (kinds.size > 1 && (kinds.has("scalar") || kinds.has("singleton")))
    return deny("inconsistent_role_evidence");
  if (kinds.has("scalar")) return deny("insufficient_shape_evidence");
  const detail = kinds.has("singleton"),
    paths = new Set(readings.map(({ itemsPath }) => JSON.stringify(itemsPath))),
    keySets = detail ? [] : voting.map(supportedKeySet),
    window = windowEvidence(keySets),
    pagination = paginationEvidence(keySets),
    reasons = [];
  if (detail && cluster.dynamicSegments !== 1) return deny("metadata_only");
  if (paths.size !== 1) return deny("inconsistent_items_path");
  if (shapes.size === 0) return deny("insufficient_shape_evidence");
  if (shapes.size !== 1) return deny("inconsistent_item_shape");
  if (detail) reasons.push("detail_body_not_representable");
  if (window.ambiguous) reasons.push("ambiguous_window_keys");
  if (window.evidence) reasons.push("window_not_representable");
  if (pagination.ambiguous) reasons.push("ambiguous_cursor_keys");
  if (pagination.evidence) reasons.push("pagination_descriptor_required");
  if (pagination.evidence && pagination.evidence.styles.length > 1)
    reasons.push("ambiguous_pagination_style");
  if (cluster.replayCompatible !== true)
    reasons.push("template_not_replayable");
  return {
    endpoint,
    roles: detail
      ? ["detail"]
      : [
          "list",
          ...(window.evidence ? ["windowed"] : []),
          ...(pagination.evidence ? ["paginated"] : []),
        ],
    itemsPath: JSON.parse([...paths][0]),
    itemShape: [...shapes][0],
    support,
    windowEvidence: window.evidence,
    paginationEvidence: pagination.evidence,
    replayCompatible: reasons.length === 0,
    reasons: reasons.sort(compareText),
  };
}
export function inferEndpointRoles(observations, templateClusters, options) {
  const limits = {
      maxObservations: option(options, "maxObservations"),
      maxDepth: option(options, "maxDepth"),
      maxCandidateArrays: option(options, "maxCandidateArrays"),
    },
    bail = (reason, support) => ({
      candidates: [],
      refused: [{ endpoint: null, reason, support }],
    });
  if (!Array.isArray(observations) || !Array.isArray(templateClusters))
    return bail("invalid_input", 0);
  if (observations.length > limits.maxObservations)
    return bail("observation_limit", observations.length);
  if (templateClusters.length > limits.maxObservations)
    return bail("cluster_limit", templateClusters.length);
  const clusters = templateClusters.filter(validCluster),
    matched = clusters.map(() => []),
    ambiguous = new Set(),
    unmatched = new Map();
  for (const observation of observations) {
    if (!isRecord(observation) || typeof observation.origin !== "string")
      continue;
    const scored = clusters.flatMap((cluster, index) =>
        cluster.origin === observation.origin &&
        cluster.method === observation.method
          ? [
              {
                index,
                score: matchScore(cluster.pathPattern, observation.path),
              },
            ]
          : [],
      ),
      best = Math.max(-1, ...scored.map(({ score }) => score)),
      winners = scored.filter(({ score }) => score === best && score >= 0);
    if (winners.length === 1) matched[winners[0].index].push(observation);
    else if (winners.length > 1)
      for (const { index } of winners) ambiguous.add(index);
    else {
      const key = JSON.stringify([observation.origin, observation.method]);
      unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
    }
  }
  const candidates = [],
    refused = [];
  for (const [index, cluster] of clusters.entries()) {
    const endpoint = endpointOf(cluster),
      support = matched[index].length;
    if (!safeTemplateLiteral(cluster.pathPattern))
      refused.push({
        endpoint: { ...endpoint, template: null },
        reason: "unsafe_template_literal",
        support,
      });
    else if (ambiguous.has(index))
      refused.push({
        endpoint,
        reason: "ambiguous_template_membership",
        support,
      });
    else if (
      Number.isInteger(cluster.observations) &&
      cluster.observations !== support
    )
      refused.push({ endpoint, reason: "template_support_mismatch", support });
    else {
      const result = candidateFor(
        cluster,
        matched[index].filter(votes),
        limits,
      );
      (result.reason ? refused : candidates).push(result);
    }
  }
  for (const [key, count] of unmatched) {
    const [origin, method] = JSON.parse(key);
    refused.push({
      endpoint: { origin, method, template: null },
      reason: "unmatched_observation",
      support: count,
    });
  }
  const order = (a, b) => compareText(JSON.stringify(a), JSON.stringify(b));
  return {
    candidates: candidates.sort(order),
    refused: refused.sort(order),
  };
}
export { HARD as ROLE_HARD_LIMITS };
