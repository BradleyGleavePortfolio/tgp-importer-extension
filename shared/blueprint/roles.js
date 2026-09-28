// Endpoint-role candidate inference (C2b) — pure, bounded, deterministic and
// site-agnostic. It joins normalized C2a observations to URL-template clusters
// and reports STRUCTURAL evidence only: collection vs single entity vs neither,
// plus window/pagination hints from supported query NAMES. It never emits a
// runnable blueprint, confidence score, id field, edge, or pagination
// descriptor; ambiguity always fails closed into `refused`. Output carries only
// origin, method, a value-free template (see sessionSlotTemplate), a
// value-free items path (see publicItemsPath: every container key is a typed
// slot or a dynamic-key marker, never its raw name), C2a shape signatures
// (which omit property names), query names from a fixed supported set, and
// counts — never response values, ids, JSON keys, query values, headers,
// timestamps, or bodies.
import { isCredentialKey } from "../credential-policy.js";
import { compareText } from "./order.js";
import { shapeSignature } from "./shapes.js";
import {
  candidateKind,
  safeOrigin,
  SUPPORTED_QUERY_KEYS,
} from "./url-templates.js";
const HARD = Object.freeze({
    maxObservations: 1000,
    maxDepth: 4,
    maxCandidateArrays: 16,
  }),
  SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/,
  PROTOTYPE_KEY = /^(?:__proto__|prototype|constructor)$/,
  // Internal-only path marker for a map-shaped level. It fails SAFE_KEY, so no
  // walked (non-map) key can ever equal it, and it is never emitted.
  DYNAMIC_KEY = "\u0000*",
  // A map needs this many keys to be recognized from homogeneity alone; fewer
  // name-like keys under equal values may be structure, and stay slots.
  MAP_MIN_KEYS = 3;
const WINDOW_PAIRS = [
    ["from", "to"],
    ["since", "until"],
    ["start", "end"],
  ],
  PAGINATION_KEYS = new Set(["cursor", "limit", "offset", "page", "per_page"]),
  CURSOR_HINTS = ["after", "before"],
  CONTACT_LITERAL = /@|\+?\d[\d ()-]{5,}\d/,
  // A signature the shape budget could not fully inspect is not evidence.
  UNINSPECTED_SHAPE = /\((?:overflow|cycle)\)|unsupported|\.\.\./;
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
// A key that is never acceptable, even as map data: a prototype name or a
// credential name aborts the endpoint rather than being walked or summarized.
function forbiddenKey(key) {
  return PROTOTYPE_KEY.test(key) || isCredentialKey(key);
}
// Name-like: syntactically a safe identifier AND not an id C2a recognizes.
// Everything else (ids, emails, spaces, dots, Unicode, leading digits) reads
// as data, never as a name.
function nameLikeKey(key) {
  return safePathKey(key) && candidateKind(key) === null;
}
// Map-shaped object: its keys are data, not structure. Recognized positively
// from the values — every value is an array, or every value is an object, and
// all values share ONE shape signature — plus either a data-like key (any key
// that is not name-like) or at least MAP_MIN_KEYS distinct keys. A map level
// is summarized as one DYNAMIC_KEY step whose items are the values (or, for a
// map of arrays, the arrays' items). Ambiguous objects are not maps; they are
// walked, and their keys still leave only as slots.
function mapShaped(node) {
  const keys = Object.keys(node);
  if (keys.length === 0) return false;
  const values = keys.map((key) => node[key]);
  if (!values.every(Array.isArray) && !values.every(isRecord)) return false;
  const shapes = new Set(values.map((value) => shapeSignature(value)));
  if (shapes.size !== 1 || UNINSPECTED_SHAPE.test([...shapes][0])) return false;
  return keys.length >= MAP_MIN_KEYS || !keys.every(nameLikeKey);
}
// Positive-structural-proof rule for JSON keys (same rule as path literals):
// within one coach's capture, a response key such as "alice" is constant
// exactly like a structural name such as "items", so no key's structural
// status is ever positively established here. Every walked key is emitted as a
// typed slot {type:"key", slot:"kN"} (numbered left to right per path) and
// every map level as {type:"dynamic_key"}; raw key names stay in the local
// capture. A path with any key slot is never replay-compatible (the slot must
// be rebound from the current coach's own traffic: KEY_SLOT_REASON); a dynamic
// key has no replay-engine representation (DYNAMIC_KEY_REASON). Seam for X2: a
// shared, reviewed structural-key vocabulary could later promote a slot to a
// proven name; C2b implements no vocabulary and emits no key name.
const KEY_SLOT_REASON = "session_key_rebinding_required",
  DYNAMIC_KEY_REASON = "dynamic_key_not_representable";
function publicItemsPath(path) {
  if (path === null) return null;
  let slots = 0;
  return path.map((key) =>
    key === DYNAMIC_KEY
      ? { type: "dynamic_key" }
      : { type: "key", slot: `k${(slots += 1)}` },
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
// Positive structural proof: a template's literals are reusable only when its
// own joined observations carry at least two DISTINCT values at one dynamic
// position (C2a variation evidence). Anything else — including every
// zero-dynamic template — may be one coach's or client's path, so its template
// is withheld and it is never replay-compatible.
function provenTemplate(pattern, rows) {
  return pattern
    .split("/")
    .some(
      (part, index) =>
        part === ":id" &&
        new Set(rows.map((row) => decodeSegment(row.path.split("/")[index])))
          .size >= 2,
    );
}
// Variation at a dynamic position proves THAT position only. It says nothing
// about the template's literal segments: within one coach's capture a coach or
// tenant slug is constant exactly like a structural name ("/coaches/alice/
// clients/:id/workouts"), so no literal's structural status is ever positively
// established here. Every literal is therefore emitted as a SESSION-SCOPED slot
// `:s1`, `:s2`, ... (numbered left to right, per template) whose raw value never
// leaves the local capture; the emitted template keeps only arity and the
// positions of C2a `:id` values. A template with any slot is never
// replay-compatible: the slots must first be rebound from the current coach's
// own observed traffic, which C2b does not do (seam for X2/X3, see
// SESSION_SLOT_REASON). Feeding a slot template to the replay engine directly
// would fill every `:param` with one per-item value, so the flag must hold.
const SESSION_SLOT_REASON = "session_slot_rebinding_required";
function sessionSlotTemplate(pattern) {
  let slots = 0;
  const template = pattern
    .split("/")
    .map((segment, index) =>
      index === 0 || segment === ":id" ? segment : `:s${(slots += 1)}`,
    )
    .join("/");
  return { template, slots };
}
function validCluster(cluster) {
  return (
    isRecord(cluster) &&
    safeOrigin(cluster.origin) &&
    ["GET", "HEAD"].includes(cluster.method) &&
    typeof cluster.pathPattern === "string" &&
    cluster.pathPattern.startsWith("/")
  );
}
function endpointOf(cluster, proven) {
  return {
    origin: cluster.origin,
    method: cluster.method,
    template: proven ? sessionSlotTemplate(cluster.pathPattern).template : null,
  };
}
// Bounded key-sorted walk collecting every array within maxDepth object keys.
// A branch stops at its first array (an array inside an array is item structure,
// not a container path) or at a map-shaped object (its values are the items);
// a forbidden key anywhere, or a data-like key outside a recognized map, aborts
// the endpoint instead of being walked.
function collectArrays(body, limits) {
  const found = [];
  let unsafe = false;
  const walk = (node, path) => {
    if (found.length > limits.maxCandidateArrays) return;
    if (Array.isArray(node)) return void found.push({ path, items: node });
    if (!isRecord(node) || path.length >= limits.maxDepth) return;
    const keys = Object.keys(node).sort(compareText);
    if (keys.some(forbiddenKey)) return void (unsafe = true);
    if (mapShaped(node)) {
      const values = keys.map((key) => node[key]);
      return void found.push({
        path: [...path, DYNAMIC_KEY],
        items: values.every(Array.isArray) ? values.flat() : values,
      });
    }
    for (const key of keys)
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
    if (variants.some((shape) => UNINSPECTED_SHAPE.test(shape)))
      return { kind: "refused", reason: "uninspected_item_shape" };
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
  if (!isRecord(body)) return { kind: "scalar" };
  const itemShape = shapeSignature(body);
  return UNINSPECTED_SHAPE.test(itemShape)
    ? { kind: "refused", reason: "uninspected_item_shape" }
    : { kind: "singleton", itemsPath: null, itemShape };
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
function candidateFor(cluster, voting, limits, proven) {
  const endpoint = endpointOf(cluster, proven),
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
  const itemsPath = publicItemsPath(JSON.parse([...paths][0]));
  if (!proven) reasons.push("unproven_template_literal");
  else if (sessionSlotTemplate(cluster.pathPattern).slots > 0)
    reasons.push(SESSION_SLOT_REASON);
  if (itemsPath?.some(({ type }) => type === "key"))
    reasons.push(KEY_SLOT_REASON);
  if (itemsPath?.some(({ type }) => type === "dynamic_key"))
    reasons.push(DYNAMIC_KEY_REASON);
  if (detail) reasons.push("detail_body_not_representable");
  if (window.ambiguous) reasons.push("ambiguous_window_keys");
  if (window.evidence) reasons.push("window_not_representable");
  if (pagination.ambiguous) reasons.push("ambiguous_cursor_keys");
  if (pagination.evidence) reasons.push("pagination_descriptor_required");
  if (pagination.evidence && pagination.evidence.styles.length > 1)
    reasons.push("ambiguous_pagination_style");
  return {
    endpoint,
    roles: detail
      ? ["detail"]
      : [
          "list",
          ...(window.evidence ? ["windowed"] : []),
          ...(pagination.evidence ? ["paginated"] : []),
        ],
    itemsPath,
    itemShape: [...shapes][0],
    support,
    windowEvidence: window.evidence,
    paginationEvidence: pagination.evidence,
    replayCompatible: reasons.length === 0,
    reasons: reasons.sort(compareText),
  };
}
// X3 seam, made visible here: slot numbering is per template, so two distinct
// observed routes (e.g. "/coaches/alice/clients/:id/workouts" and
// "/groups/bob/members/:id/workouts") can collapse to one emitted
// (origin, method, template). They are never merged: each stays its own entry,
// and every candidate in such a group carries COLLISION_REASON (so it is not
// replay-compatible) even when the colliding partner was refused. Origin,
// method, arity and :id positions are NOT sufficient for rebinding; X3 must
// fail closed on 0 or >1 bindings unless independently validated evidence
// disambiguates. (Origin itself may carry a tenant name — see the X2 seam in
// the PR notes; C2b scopes by origin but does not parameterize it.)
const COLLISION_REASON = "slot_template_collision";
function flagSlotCollisions(candidates, refused) {
  const keyOf = ({ endpoint }) =>
      endpoint?.template
        ? JSON.stringify([endpoint.origin, endpoint.method, endpoint.template])
        : null,
    counts = new Map();
  for (const entry of [...candidates, ...refused]) {
    const key = keyOf(entry);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const candidate of candidates)
    if ((counts.get(keyOf(candidate)) ?? 0) > 1) {
      candidate.reasons = [...candidate.reasons, COLLISION_REASON].sort(
        compareText,
      );
      candidate.replayCompatible = false;
    }
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
  let badOrigins = templateClusters.filter(
    (cluster) => isRecord(cluster) && !safeOrigin(cluster.origin),
  ).length;
  const clusters = templateClusters.filter(validCluster),
    matched = clusters.map(() => []),
    ambiguous = new Set(),
    unmatched = new Map();
  for (const observation of observations) {
    if (!isRecord(observation)) continue;
    if (!safeOrigin(observation.origin)) {
      badOrigins += 1;
      continue;
    }
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
    const endpoint = endpointOf(
        cluster,
        provenTemplate(cluster.pathPattern, matched[index]),
      ),
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
    else if (cluster.replayCompatible !== true)
      refused.push({ endpoint, reason: "template_not_replayable", support });
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
        endpoint.template !== null,
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
  // A rejected origin is never echoed: it may carry userinfo credentials.
  if (badOrigins > 0)
    refused.push({
      endpoint: null,
      reason: "invalid_origin",
      support: badOrigins,
    });
  flagSlotCollisions(candidates, refused);
  const order = (a, b) => compareText(JSON.stringify(a), JSON.stringify(b));
  return {
    candidates: candidates.sort(order),
    refused: refused.sort(order),
  };
}
export {
  COLLISION_REASON,
  DYNAMIC_KEY_REASON,
  HARD as ROLE_HARD_LIMITS,
  KEY_SLOT_REASON,
  SESSION_SLOT_REASON,
};
