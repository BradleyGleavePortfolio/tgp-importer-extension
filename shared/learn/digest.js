// StructureDigestV1 builder (L0 D-L0-2) — the device-side PII boundary.
//
// Input is the redacted capture (credentials already scrubbed, non-secret PII
// deliberately still present). Output is STRUCTURE ONLY: URL templates with
// every non-structural segment parameterised, query-key NAMES, status codes,
// counts, role verdicts from roles.js, key/kind ShapeNodes (never a value),
// same-origin link templates (never link text) and constant request headers.
//
// Positive-evidence rule for path literals (C2B1-SOL-A1 / X2-1). A literal
// segment is transmitted in clear ONLY when its structural status is
// positively established without any per-coach knowledge:
//   - it is a version marker (v1..v999), or
//   - the same word (case-insensitive, one trailing "s" ignored) is already a
//     key of a response shape in THIS capture — a word the digest transmits
//     anyway, so the path adds no new bytes.
// Every other segment is a parameter. A position whose decoded value VARIES
// across the template's observations is an item parameter `:pN` (filled by a
// forEach set at replay). A position with ONE fixed value — a coach slug, a
// tenant id, an api prefix such as `proxy/api`, a lone client id — is a
// session slot `:sN`: its value stays on the device (`slots`), is filled at
// compile time from this run's own capture, and is never transmitted, logged
// or persisted. The template itself is still listed, so every observed
// collection reaches the proposal (amendment A1). Header values follow the
// same rule: MIME lists and vocabulary words go in clear, anything else is a
// `:hN` slot held on the device.
import { normalizeCaptureSnapshot } from "../blueprint/input.js";
import { compareText } from "../blueprint/order.js";
import { inferEndpointRoles } from "../blueprint/roles.js";
import {
  candidateKind,
  inferUrlTemplates,
  safeOrigin,
  SUPPORTED_QUERY_KEYS,
} from "../blueprint/url-templates.js";
import { isCredentialKey, redactCredentialText } from "../credential-policy.js";
import { isStructuralWord, VOCABULARY_VERSION } from "./vocabulary.js";

export const DIGEST_VERSION = 1;
export const DIGEST_LIMITS = Object.freeze({
  maxTemplates: 64,
  maxLinkTemplates: 64,
  maxShapeDepth: 4,
  maxObjectKeys: 64,
  maxCollectionPaths: 4,
  maxQueryKeys: 32,
  maxStatuses: 16,
  maxParams: 8,
  maxSegments: 32,
  maxLinks: 5000,
  maxBytes: 32 * 1024,
  maxMissingFamilies: 32,
  constantHeaderShare: 0.9,
  maxHeaderValueBytes: 64,
});
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/,
  SAFE_LITERAL = /^[A-Za-z][A-Za-z0-9_.~-]{0,63}$/,
  UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  INT_ID = /^(?:0|[1-9]\d{0,17})$/,
  ISO_DATE =
    /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
  EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  PHONE = /^\+?[\d\s().-]{7,24}$/,
  URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i,
  SHORT_ID = /^[A-Za-z0-9_-]{2,64}$/,
  FAMILY = /^[a-z][a-z0-9_]{0,63}$/,
  HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/,
  PRINTABLE_ASCII = /^[\x20-\x7e]*$/,
  DIGIT_RUN = /\d{4}/,
  DENIED_HEADER =
    /^(?:authorization|proxy-authorization|cookie|referer|origin|host|user-agent|content-length|content-type|accept-encoding|accept-language|if-none-match|if-modified-since|sec-.*|x-csrf.*|x-xsrf.*)$/,
  MIME =
    "(?:\\*|[a-z0-9!#$&^_.+-]+)/(?:\\*|[a-z0-9!#$&^_.+-]+)(?:\\s*;\\s*[a-z0-9-]+=[a-z0-9.-]+)*",
  MIME_LIST = new RegExp(`^${MIME}(?:\\s*,\\s*${MIME})*$`, "i"),
  STRING_BUCKETS = ["≤8", "≤32", "≤256", ">256"],
  ARRAY_BUCKETS = ["0", "1", "2-9", "10-99", "100+"],
  NOISE = new Set([
    "unmatched_observation",
    "invalid_origin",
    "no_successful_get_evidence",
  ]),
  encoder = new TextEncoder();
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function reject(reason) {
  throw new Error(reason);
}
function count(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}
function sortedCounts(map) {
  return [...map]
    .sort(([a], [b]) => compareText(a, b))
    .map(([reason, total]) => ({ reason, count: total }));
}
export function canonicalJson(value) {
  return JSON.stringify(value, (_key, child) =>
    isRecord(child)
      ? Object.fromEntries(
          Object.keys(child)
            .sort(compareText)
            .map((key) => [key, child[key]]),
        )
      : child,
  );
}
// ---- shapes (keys + kinds + classes; never a value) --------------------------
function stringClass(text) {
  if (INT_ID.test(text)) return "int_id";
  if (UUID.test(text)) return "uuid";
  if (ISO_DATE.test(text)) return "iso_date";
  if (EMAIL.test(text)) return "email_like";
  if (PHONE.test(text) && (text.match(/\d/g) ?? []).length >= 7)
    return "phone_like";
  if (URL_LIKE.test(text)) return "url";
  return SHORT_ID.test(text) && /\d/.test(text) ? "short_id" : "text";
}
function bucket(order, index) {
  return order[index];
}
function stringBucket(length) {
  return bucket(
    STRING_BUCKETS,
    length <= 8 ? 0 : length <= 32 ? 1 : length <= 256 ? 2 : 3,
  );
}
function arrayBucket(length) {
  return bucket(
    ARRAY_BUCKETS,
    length === 0
      ? 0
      : length === 1
        ? 1
        : length < 10
          ? 2
          : length < 100
            ? 3
            : 4,
  );
}
function maxBucket(order, a, b) {
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}
// A key that looks like a value (digit-led, uuid, three or more digits) is a
// map keyed by data, not a field name, and is dropped.
function safeShapeKey(key) {
  return (
    SAFE_KEY.test(key) &&
    !isCredentialKey(key) &&
    !/^\d/.test(key) &&
    !UUID.test(key) &&
    (key.match(/\d/g) ?? []).length < 3
  );
}
function shapeOf(value, depth, limits) {
  if (value === null) return { kind: "null" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (typeof value === "number")
    return { kind: "number", class: Number.isInteger(value) ? "int" : "float" };
  if (typeof value === "string")
    return {
      kind: "string",
      class: stringClass(value),
      lengthBucket: stringBucket(value.length),
    };
  if (Array.isArray(value)) {
    const lengthBucket = arrayBucket(value.length);
    if (depth >= limits.maxShapeDepth)
      return { kind: "array", items: { kind: "mixed" }, lengthBucket };
    // An empty array has no item evidence: "unknown" is the merge identity and
    // is finalised to `mixed` when it is all that was ever seen.
    const items = value
      .map((item) => shapeOf(item, depth + 1, limits))
      .reduce(
        (merged, item) => (merged ? mergeShape(merged, item) : item),
        null,
      );
    return { kind: "array", items: items ?? { kind: "unknown" }, lengthBucket };
  }
  if (!isRecord(value)) return { kind: "mixed" };
  if (depth >= limits.maxShapeDepth) return { kind: "object", keys: {} };
  const all = Object.keys(value),
    names = all.filter(safeShapeKey).sort(compareText);
  // Keys that are really data (ids, dates, names) make the object a `map`:
  // only the merged VALUE shape is kept, never a key.
  if (names.length * 2 <= all.length && all.length > 0)
    return {
      kind: "map",
      values: mergeAll(
        all.map((key) => shapeOf(value[key], depth + 1, limits)),
      ),
    };
  const keys = {};
  for (const key of names.slice(0, limits.maxObjectKeys))
    keys[key] = shapeOf(value[key], depth + 1, limits);
  return { kind: "object", keys };
}
function mergeAll(shapes) {
  return (
    shapes.reduce(
      (merged, item) => (merged ? mergeShape(merged, item) : item),
      null,
    ) ?? { kind: "unknown" }
  );
}
function mergeShape(a, b) {
  if (a.kind === "null" || a.kind === "unknown") return b;
  if (b.kind === "null" || b.kind === "unknown") return a;
  if (a.kind !== b.kind) return { kind: "mixed" };
  if (a.kind === "object") {
    const keys = {},
      optional = new Set([...(a.optional ?? []), ...(b.optional ?? [])]);
    for (const key of [
      ...new Set([...Object.keys(a.keys), ...Object.keys(b.keys)]),
    ].sort(compareText)) {
      const left = a.keys[key],
        right = b.keys[key];
      if (left && right) keys[key] = mergeShape(left, right);
      else {
        keys[key] = left ?? right;
        optional.add(key);
      }
    }
    const out = { kind: "object", keys };
    if (optional.size > 0) out.optional = [...optional].sort(compareText);
    return out;
  }
  if (a.kind === "map")
    return { kind: "map", values: mergeShape(a.values, b.values) };
  if (a.kind === "array")
    return {
      kind: "array",
      items: mergeShape(a.items, b.items),
      lengthBucket: maxBucket(ARRAY_BUCKETS, a.lengthBucket, b.lengthBucket),
    };
  if (a.kind === "string")
    return {
      kind: "string",
      class: a.class === b.class ? a.class : "text",
      lengthBucket: maxBucket(STRING_BUCKETS, a.lengthBucket, b.lengthBucket),
    };
  if (a.kind === "number")
    return { kind: "number", class: a.class === b.class ? a.class : "float" };
  return { kind: a.kind };
}
// Final pass: `unknown` becomes `mixed`, and a wide, high-variance key set
// (more than 16 keys of which at least three quarters are optional) is a map
// keyed by data — collapsed to its value shape.
function finalizeShape(node) {
  if (node.kind === "unknown") return { kind: "mixed" };
  if (node.kind === "array")
    return { ...node, items: finalizeShape(node.items) };
  if (node.kind === "map")
    return { kind: "map", values: finalizeShape(node.values) };
  if (node.kind !== "object") return node;
  const names = Object.keys(node.keys),
    optional = node.optional ?? [];
  if (names.length > 16 && optional.length * 4 >= names.length * 3)
    return finalizeShape({
      kind: "map",
      values: mergeAll(names.map((key) => node.keys[key])),
    });
  const keys = {};
  for (const key of names) keys[key] = finalizeShape(node.keys[key]);
  return { ...node, keys };
}
function objectArrayPaths(node, prefix, out, maxDepth) {
  if (node.kind === "array" && node.items.kind === "object") out.push(prefix);
  if (node.kind !== "object" || prefix.length >= maxDepth) return;
  for (const key of Object.keys(node.keys))
    objectArrayPaths(node.keys[key], [...prefix, key], out, maxDepth);
}
function normalizeWord(word) {
  return word.toLowerCase().replace(/s$/, "");
}
// Vocabulary = every safe shape key plus its tokens (split on `_`, `-`, digits
// and camelCase), normalised. These words are transmitted as keys anyway.
function addWords(key, out) {
  out.add(normalizeWord(key));
  for (const token of key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter((token) => token.length >= 2))
    out.add(normalizeWord(token));
}
function collectVocabulary(node, out) {
  if (node.kind === "array") collectVocabulary(node.items, out);
  if (node.kind === "map") collectVocabulary(node.values, out);
  if (node.kind !== "object") return;
  for (const key of Object.keys(node.keys)) {
    addWords(key, out);
    collectVocabulary(node.keys[key], out);
  }
}
// ---- paths: skeletons, parameters and session slots --------------------------
function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw).normalize("NFC");
  } catch {
    return null;
  }
}
// Skeleton: `clear` literals (positively established), `id`-like segments
// (decided by variation) and other `literal`s (always a session slot; they
// keep distinct endpoints apart in the grouping key but never leave the
// device). null = the path is unsafe and its template is withheld.
function skeletonOf(path, limits) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\x00-\x1f\x7f?#]/.test(path)
  )
    return null;
  const raw = path.split("/").slice(1);
  if (raw.length > limits.maxSegments) return null;
  const segments = [];
  for (const part of raw) {
    const decoded = decodeSegment(part);
    if (decoded === null || decoded.length === 0 || decoded.length > 256)
      return null;
    // Positive proof (a): the closed vocabulary (or a version marker). The
    // shape words of this capture are NOT proof: one coach's response keys
    // could equal that coach's own slug.
    if (isStructuralWord(decoded))
      segments.push({ kind: "clear", text: decoded.toLowerCase() });
    else if (candidateKind(decoded) !== null || /\d/.test(decoded))
      segments.push({ kind: "id", value: decoded });
    else segments.push({ kind: "literal", value: decoded });
  }
  const key = segments
    .map((segment) =>
      segment.kind === "clear"
        ? segment.text
        : segment.kind === "id"
          ? "*"
          : `~${segment.value}`,
    )
    .join("/");
  return { key, segments };
}
// Resolve one skeleton group into a template: an id position with ≥ 2 distinct
// values is an item parameter `:pN`; every other non-clear segment is a
// device-held session slot `:sN`.
function resolveGroup(skeletons, limits) {
  const slots = [];
  let params = 0,
    slotCount = 0;
  const parts = skeletons[0].segments.map((segment, index) => {
    if (segment.kind === "clear") return segment.text;
    const distinct = new Set(
      skeletons.map((item) => item.segments[index].value),
    );
    if (segment.kind === "id" && distinct.size >= 2) return `:p${++params}`;
    slots.push([...distinct][0]);
    return `:s${++slotCount}`;
  });
  if (params + slotCount > limits.maxParams) return null;
  return { template: `/${parts.join("/")}`, params, slots };
}
function groupBy(items, keyFor) {
  const out = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (key === null) continue;
    const group = out.get(key) ?? [];
    group.push(item);
    out.set(key, group);
  }
  return out;
}
// ---- roles: translate roles.js verdicts into collection|single|refused -------
function votes({ method, status }) {
  return (
    method === "GET" &&
    (status === null ||
      status === undefined ||
      (Number.isInteger(status) && status >= 200 && status < 300))
  );
}
function refusal(reason) {
  return { role: "refused", itemsPath: null, refusal: reason };
}
function roleOf(observations) {
  const { clusters } = inferUrlTemplates(observations),
    result = inferEndpointRoles(observations, clusters),
    refused = result.refused
      .filter((entry) => !NOISE.has(entry.reason))
      .map((entry) => entry.reason)
      .sort(compareText);
  if (refused.length > 0) return refusal(refused[0]);
  if (result.candidates.length === 0)
    return refusal("no_successful_get_evidence");
  const kinds = new Set(
    result.candidates.map((candidate) =>
      candidate.roles.includes("detail")
        ? "single"
        : candidate.roles.includes("list")
          ? "collection"
          : "refused",
    ),
  );
  if (kinds.size !== 1 || kinds.has("refused"))
    return refusal("inconsistent_role_evidence");
  if (kinds.has("single"))
    return { role: "single", itemsPath: null, refusal: null };
  const paths = new Set(
    result.candidates.map((candidate) => JSON.stringify(candidate.itemsPath)),
  );
  return paths.size === 1
    ? {
        role: "collection",
        itemsPath: JSON.parse([...paths][0]),
        refusal: null,
      }
    : refusal("inconsistent_items_path");
}
// Query NAMES only: pagination/window vocabulary or a shape word. Every other
// observed name is counted as withheld, and each transmitted name carries the
// number of DISTINCT values observed (a filter such as `?status=` with two
// variants is two lists, never one), so nothing is dropped silently.
function queryKeysOf(observations, vocabulary, variants, limits) {
  const names = new Set(),
    withheld = new Set();
  for (const observation of observations)
    for (const key of Array.isArray(observation.queryKeys)
      ? observation.queryKeys
      : [])
      if (
        typeof key === "string" &&
        SAFE_KEY.test(key) &&
        !isCredentialKey(key) &&
        (SUPPORTED_QUERY_KEYS.has(key.toLowerCase()) ||
          vocabulary.has(normalizeWord(key)))
      )
        names.add(key);
      else withheld.add(String(key));
  const queryKeys = [...names].sort(compareText).slice(0, limits.maxQueryKeys),
    queryVariants = {};
  for (const name of queryKeys) {
    const values = new Set();
    for (const observation of observations)
      for (const value of variants
        .get(`${observation.method} ${observation.path}`)
        ?.get(name) ?? [])
        values.add(value);
    queryVariants[name] = Math.max(1, values.size);
  }
  return {
    queryKeys,
    queryVariants,
    withheldQueryKeys:
      withheld.size + Math.max(0, names.size - queryKeys.length),
  };
}
// Distinct query VALUES per (method, path, name) from the raw same-origin
// entries; only their COUNT ever leaves the device.
function queryVariantsOf(entries, origin) {
  const out = new Map();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.url !== "string") continue;
    let url;
    try {
      url = new URL(entry.url);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    const key = `${String(entry.method).toUpperCase()} ${url.pathname}`,
      byName = out.get(key) ?? new Map();
    for (const [name, value] of url.searchParams)
      (byName.get(name) ?? byName.set(name, new Set()).get(name)).add(value);
    out.set(key, byName);
  }
  return out;
}
function templateOf(observations, resolved, vocabulary, variants, limits) {
  const voting = observations.filter(votes),
    shape = finalizeShape(
      voting
        .map((observation) => shapeOf(observation.body, 0, limits))
        .reduce(
          (merged, item) => (merged ? mergeShape(merged, item) : item),
          null,
        ) ?? { kind: "unknown" },
    ),
    verdict =
      voting.length === 0
        ? refusal("no_successful_get_evidence")
        : roleOf(observations),
    paths = [];
  objectArrayPaths(shape, [], paths, limits.maxShapeDepth);
  paths.sort(
    (a, b) => a.length - b.length || compareText(a.join("/"), b.join("/")),
  );
  let role = verdict.role,
    reason = verdict.refusal,
    collectionPaths = paths;
  if (role === "collection") {
    const wanted = JSON.stringify(verdict.itemsPath);
    if (paths.some((path) => JSON.stringify(path) === wanted))
      collectionPaths = [
        verdict.itemsPath,
        ...paths.filter((path) => JSON.stringify(path) !== wanted),
      ];
    else {
      role = "refused";
      reason = "items_path_not_in_shape";
    }
  }
  const statuses = [
    ...new Set(
      observations
        .map(({ status }) => status)
        .filter((status) => Number.isInteger(status)),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, limits.maxStatuses);
  return {
    ref: "",
    method: observations[0].method,
    template: resolved.template,
    ...queryKeysOf(observations, vocabulary, variants, limits),
    statuses,
    observations: observations.length,
    role,
    refusal: reason,
    collectionPaths: collectionPaths.slice(0, limits.maxCollectionPaths),
    shape,
  };
}
// ---- constant request headers (deterministic rule, never model output) --------
// A value is transmitted in clear only for a known protocol header NAME whose
// value matches that header's protocol grammar. Every other constant header is
// sent as its NAME plus a `:hN` session-slot marker; the value stays on the
// device (a tenant slug is a value, L0R2-OPUS-B6).
const PROTOCOL_HEADERS = new Map([
  ["accept", MIME_LIST],
  ["x-requested-with", /^[A-Za-z]{1,32}$/],
  ["cache-control", /^[a-z-]+(?:\s*,\s*[a-z-]+)*$/i],
  ["pragma", /^[a-z-]+$/i],
]);
function headerValueClass(name, value) {
  const grammar = PROTOCOL_HEADERS.get(name);
  return grammar !== undefined && grammar.test(value) ? "clear" : "slot";
}
function constantHeadersOf(entries, origin, limits) {
  const rows = entries.filter((entry) => {
    if (!isRecord(entry) || typeof entry.url !== "string") return false;
    try {
      return (
        new URL(entry.url).origin === origin &&
        ["GET", "HEAD"].includes(String(entry.method).toUpperCase())
      );
    } catch {
      return false;
    }
  });
  const seen = new Map();
  for (const row of rows)
    if (isRecord(row.requestHeaders))
      for (const [name, value] of Object.entries(row.requestHeaders))
        count(seen, JSON.stringify([name.toLowerCase(), value]));
  const headers = {},
    slots = {},
    needed = Math.ceil(rows.length * limits.constantHeaderShare);
  let slotCount = 0;
  for (const [key, total] of [...seen].sort(([a], [b]) => compareText(a, b))) {
    const [name, value] = JSON.parse(key);
    if (
      rows.length === 0 ||
      total < needed ||
      !HEADER_TOKEN.test(name) ||
      DENIED_HEADER.test(name) ||
      isCredentialKey(name) ||
      typeof value !== "string" ||
      value.length === 0 ||
      !PRINTABLE_ASCII.test(value) ||
      encoder.encode(value).length > limits.maxHeaderValueBytes ||
      DIGIT_RUN.test(value) ||
      UUID.test(value) ||
      candidateKind(value) !== null ||
      /@|:\/\/|^(?:<redacted>|\[redacted\])$/i.test(value) ||
      redactCredentialText(value) !== value ||
      Object.hasOwn(headers, name)
    )
      continue;
    if (headerValueClass(name, value) === "clear") headers[name] = value;
    else {
      headers[name] = `:h${++slotCount}`;
      slots[name] = value;
    }
  }
  return { headers, slots };
}
// ---- link inventory (same-origin paths only; never text, query or fragment) ----
function linkPathsOf(links, origin, excluded, limits) {
  if (!Array.isArray(links)) return [];
  if (links.length > limits.maxLinks) {
    count(excluded, "link_limit", links.length);
    return [];
  }
  const out = [];
  for (const href of links) {
    let url;
    try {
      url = new URL(String(href), `${origin}/`);
    } catch {
      count(excluded, "invalid_link");
      continue;
    }
    if (url.origin !== origin) count(excluded, "foreign_link");
    else out.push(url.pathname);
  }
  return out;
}
function authorizedOriginFrom(options) {
  const origin = isRecord(options) ? options.authorizedOrigin : undefined;
  if (typeof origin !== "string" || !safeOrigin(origin))
    reject("invalid_authorized_origin");
  return origin;
}
function missingFamiliesFrom(options, limits) {
  const raw = isRecord(options) ? options.missingFamilies : undefined;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > limits.maxMissingFamilies)
    reject("invalid_missing_families");
  return [
    ...new Set(
      raw.map((family) =>
        typeof family === "string" && FAMILY.test(family)
          ? family
          : reject("invalid_missing_families"),
      ),
    ),
  ].sort(compareText);
}
/**
 * Positive structural proof (b), server-side cross-coach equality by hash:
 * a typed seam. When supplied, every template session slot value is passed
 * through it and the result travels as `slotProofs[ref][i]`. The function
 * MUST be a salted per-run hash (never the raw value, never a stable cross-run
 * hash); the digest carries whatever it returns, so the caller owns that
 * guarantee. Without it, slots carry nothing.
 * @typedef {(word: string) => string} SlotProof
 */
export function buildStructureDigest(capture, options) {
  const limits = DIGEST_LIMITS,
    origin = authorizedOriginFrom(options),
    slotProof =
      typeof options?.slotProof === "function" ? options.slotProof : null,
    round = options?.round === 2 ? 2 : 1,
    missingFamilies = round === 2 ? missingFamiliesFrom(options, limits) : [],
    excluded = new Map();
  const normalized = normalizeCaptureSnapshot(capture, {
    expectedOrigin: origin,
  });
  for (const { reason, count: total } of normalized.excluded)
    count(excluded, reason, total);
  const observations = normalized.observations,
    variants = queryVariantsOf(Array.isArray(capture) ? capture : [], origin),
    vocabulary = new Set();
  for (const observation of observations.filter(votes))
    collectVocabulary(shapeOf(observation.body, 0, limits), vocabulary);
  // API templates: group by method + clear-literal skeleton, resolve slots.
  const skeletons = new Map(),
    groups = groupBy(observations, (observation) => {
      const skeleton = skeletonOf(observation.path, limits);
      if (skeleton === null) {
        count(excluded, "unsafe_path");
        return null;
      }
      skeletons.set(observation, skeleton);
      return JSON.stringify([observation.method, skeleton.key]);
    });
  const byTemplate = new Map();
  for (const group of groups.values()) {
    const resolved = resolveGroup(
      group.map((observation) => skeletons.get(observation)),
      limits,
    );
    if (resolved === null) {
      count(excluded, "parameter_limit", group.length);
      continue;
    }
    const key = `${group[0].method} ${resolved.template}`,
      entry = byTemplate.get(key) ?? { groups: [], resolved };
    entry.groups.push(group);
    byTemplate.set(key, entry);
  }
  // Two distinct endpoints that mask to the same template cannot be told
  // apart by the server: they are listed once, refused, with no slots.
  let templates = [],
    templateSlots = new Map();
  for (const { groups: members, resolved } of byTemplate.values()) {
    const template = templateOf(
      members.flat(),
      resolved,
      vocabulary,
      variants,
      limits,
    );
    if (members.length > 1) {
      count(excluded, "template_collision", members.length);
      template.role = "refused";
      template.refusal = "template_collision";
      templateSlots.set(template, []);
    } else templateSlots.set(template, resolved.slots);
    templates.push(template);
  }
  // Link templates: one "observation" per same-origin href path. A group is
  // explored when any of its paths was navigated (options.exploredLinks).
  const explored = new Set(
    linkPathsOf(options?.exploredLinks, origin, new Map(), limits),
  );
  const linkGroups = groupBy(
    linkPathsOf(options?.links, origin, excluded, limits),
    (path) => {
      const skeleton = skeletonOf(path, limits);
      if (skeleton === null) count(excluded, "unsafe_link");
      return skeleton === null ? null : skeleton.key;
    },
  );
  const linkByTemplate = new Map();
  for (const group of linkGroups.values()) {
    const resolved = resolveGroup(
      group.map((path) => skeletonOf(path, limits)),
      limits,
    );
    if (resolved === null) {
      count(excluded, "parameter_limit", group.length);
      continue;
    }
    const entries = linkByTemplate.get(resolved.template) ?? [];
    entries.push({
      ...resolved,
      count: group.length,
      explored: group.some((path) => explored.has(path)),
    });
    linkByTemplate.set(resolved.template, entries);
  }
  let links = [];
  for (const entries of linkByTemplate.values())
    if (entries.length === 1) links.push(entries[0]);
    else count(excluded, "link_collision", entries.length);
  // Bounds: collections first, then largest observation counts; canonical
  // JSON ≤ maxBytes by dropping links, then non-collections, then collections.
  templates.sort(
    (a, b) =>
      Number(b.role === "collection") - Number(a.role === "collection") ||
      b.observations - a.observations ||
      compareText(a.method + a.template, b.method + b.template),
  );
  links.sort(
    (a, b) => b.count - a.count || compareText(a.template, b.template),
  );
  const totalTemplates = templates.length,
    totalLinks = links.length;
  let truncated =
    templates.length > limits.maxTemplates ||
    links.length > limits.maxLinkTemplates;
  templates = templates.slice(0, limits.maxTemplates);
  links = links.slice(0, limits.maxLinkTemplates);
  const { headers, slots: headerSlots } = constantHeadersOf(
    Array.isArray(capture) ? capture : [],
    origin,
    limits,
  );
  const assemble = () => {
    const ordered = [...templates].sort((a, b) =>
      compareText(a.method + a.template, b.method + b.template),
    );
    ordered.forEach((template, index) => {
      template.ref = `t${index}`;
    });
    // Everything withheld is reported by reason and count (never by value), so
    // the backend can hold `complete` open on it instead of losing it silently.
    const withheld = new Map(excluded);
    if (templates.length < totalTemplates)
      count(withheld, "truncated_templates", totalTemplates - templates.length);
    if (links.length < totalLinks)
      count(withheld, "truncated_links", totalLinks - links.length);
    return {
      digestVersion: DIGEST_VERSION,
      vocabularyVersion: VOCABULARY_VERSION,
      sourcePlatform: new URL(origin).hostname.toLowerCase(),
      round,
      templates: ordered,
      linkTemplates: links.map(({ template }) => template).sort(compareText),
      exploredLinkTemplates: links
        .filter(({ explored: seen }) => seen)
        .map(({ template }) => template)
        .sort(compareText),
      constantHeaders: headers,
      missingFamilies,
      truncated,
      withheld: sortedCounts(withheld),
    };
  };
  let digest = assemble();
  while (encoder.encode(canonicalJson(digest)).length > limits.maxBytes) {
    truncated = true;
    if (links.length > 0) links.pop();
    else if (templates.length > 0) templates.pop();
    else break;
    digest = assemble();
  }
  const slots = { templates: {}, links: {}, headers: headerSlots };
  for (const template of digest.templates)
    if (templateSlots.get(template).length > 0)
      slots.templates[template.ref] = templateSlots.get(template);
  if (slotProof !== null) {
    const proofs = {};
    for (const ref of Object.keys(slots.templates).sort(compareText))
      proofs[ref] = slots.templates[ref].map((word) => {
        const proof = slotProof(word);
        if (
          typeof proof !== "string" ||
          !/^[0-9a-f]{16,64}$/.test(proof) ||
          proof === word
        )
          throw new Error("learn_digest_invalid_slot_proof");
        return proof;
      });
    digest.slotProofs = proofs;
    if (encoder.encode(canonicalJson(digest)).length > limits.maxBytes) {
      delete digest.slotProofs;
      const withheld = new Map(
        digest.withheld.map(({ reason, count: n }) => [reason, n]),
      );
      count(withheld, "slot_proofs_over_budget", Object.keys(proofs).length);
      digest.withheld = sortedCounts(withheld);
    }
  }
  for (const link of links)
    if (link.slots.length > 0) slots.links[link.template] = link.slots;
  return { digest, slots, excluded: digest.withheld };
}
export { stringClass, shapeOf, mergeShape };
