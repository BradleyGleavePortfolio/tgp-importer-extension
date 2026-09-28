// Learned-blueprint compiler (L0 D-L0-4 extension gate). It turns the
// server-validated package HINTS (proposal steps: template refs, entity types,
// items paths, id fields, fan-out edges, pagination) into a PlatformBlueprint.
// The server never supplies a URL, a header, a method or a budget: every
// template comes from THIS device's digest by ref, session slots are filled
// from this run's own capture, `apiBase` is the authorized origin plus the
// common literal path prefix of the used templates, headers are the digest's
// constant headers and budgets are DEFAULT_BUDGETS. The result then passes
// normalizeBlueprint under the single authorized origin; any failure throws a
// stable `learn_compile_*` code BEFORE a single request is made.
import { compareText } from "../blueprint/order.js";
import { safeOrigin } from "../blueprint/url-templates.js";
import { isCredentialKey } from "../credential-policy.js";
import { DEFAULT_BUDGETS, normalizeBlueprint } from "../replay/blueprint.js";
import { isStructuralWord } from "./vocabulary.js";

export const LEARNED_RATE_LIMIT_MS = 500;
const MAX_STEPS = 8,
  ENTITY_TYPE = /^[a-z0-9_]{1,64}$/,
  NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/,
  STEP_KEYS = new Set([
    "templateRef",
    "entityType",
    "itemsPath",
    "idField",
    "collectAs",
    "forEach",
    "pagination",
  ]),
  PAGINATION_KEYS = new Set(["style", "param", "start", "nextPath"]),
  ID_CLASSES = new Set(["int_id", "uuid", "short_id"]),
  PARAM = /^:p\d+$/,
  SLOT = /^:s\d+$/,
  HEADER_SLOT = /^:h\d+$/,
  HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/,
  PRINTABLE_ASCII = /^[\x20-\x7e]{1,256}$/;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * @param {string} code
 * @param {unknown} [cause]
 * @returns {never}
 */
function fail(code, cause) {
  const error = new Error(code);
  if (cause !== undefined) error.cause = cause;
  throw error;
}
function keyPath(value) {
  return Array.isArray(value) &&
    value.every((key) => typeof key === "string" && NAME.test(key))
    ? value
    : null;
}
function readShape(node, path) {
  let current = node;
  for (const key of path) {
    if (
      !isRecord(current) ||
      current.kind !== "object" ||
      !isRecord(current.keys)
    )
      return null;
    current = current.keys[key];
  }
  return isRecord(current) ? current : null;
}
function templateIndex(digest) {
  if (
    !isRecord(digest) ||
    digest.digestVersion !== 1 ||
    !Array.isArray(digest.templates)
  )
    fail("learn_compile_invalid_digest");
  const byRef = new Map();
  for (const template of digest.templates) {
    if (
      !isRecord(template) ||
      typeof template.ref !== "string" ||
      typeof template.template !== "string" ||
      !template.template.startsWith("/") ||
      !["GET", "HEAD"].includes(template.method) ||
      byRef.has(template.ref)
    )
      fail("learn_compile_invalid_digest");
    byRef.set(template.ref, template);
  }
  return byRef;
}
function fillSlots(template, values) {
  const filled = [],
    segments = template.split("/").slice(1);
  let params = 0,
    slots = 0;
  for (const segment of segments) {
    if (PARAM.test(segment)) {
      params += 1;
      filled.push(segment);
    } else if (SLOT.test(segment)) {
      const value = values[slots++];
      if (typeof value !== "string" || value.length === 0)
        fail("learn_compile_missing_slot");
      // A slot is ONE observed path segment: dot segments or separators would
      // let a value re-shape the path, so they are refused rather than encoded.
      if (value === "." || value === ".." || /[/\\?#\x00-\x1f\x7f]/.test(value))
        fail("learn_compile_invalid_slot");
      filled.push(encodeURIComponent(value));
    } else if (!isStructuralWord(segment) || segment !== segment.toLowerCase())
      // A clear literal must be positively proven: the closed vocabulary or a
      // version marker, lower-case. Anything else is not a digest we built.
      fail("learn_compile_invalid_digest");
    else filled.push(segment);
  }
  if (slots !== values.length) fail("learn_compile_missing_slot");
  return { path: `/${filled.join("/")}`, params };
}
function compilePagination(raw, template) {
  if (raw === null || raw === undefined) return null;
  if (
    !isRecord(raw) ||
    !Object.keys(raw).every((key) => PAGINATION_KEYS.has(key))
  )
    fail("learn_compile_pagination");
  if (
    !["page", "cursor"].includes(raw.style) ||
    typeof raw.param !== "string" ||
    !template.queryKeys.includes(raw.param)
  )
    fail("learn_compile_pagination");
  if (raw.style === "page") {
    if (raw.nextPath !== undefined) fail("learn_compile_pagination");
    if (raw.start !== undefined && !Number.isSafeInteger(raw.start))
      fail("learn_compile_pagination");
    return { style: "page", param: raw.param, start: raw.start ?? 1 };
  }
  const nextPath = keyPath(raw.nextPath);
  if (raw.start !== undefined || nextPath === null || nextPath.length === 0)
    fail("learn_compile_pagination");
  const node = readShape(template.shape, nextPath);
  if (node === null || node.kind !== "string") fail("learn_compile_pagination");
  return { style: "cursor", param: raw.param, nextPath };
}
function compileStep(raw, byRef, slots, produced) {
  if (!isRecord(raw) || !Object.keys(raw).every((key) => STEP_KEYS.has(key)))
    fail("learn_compile_invalid_hints");
  const template = byRef.get(raw.templateRef);
  if (template === undefined) fail("learn_compile_unknown_template_ref");
  if (template.role !== "collection")
    fail("learn_compile_template_not_collection");
  if (typeof raw.entityType !== "string" || !ENTITY_TYPE.test(raw.entityType))
    fail("learn_compile_entity_type");
  const itemsPath = keyPath(raw.itemsPath);
  if (
    itemsPath === null ||
    !template.collectionPaths.some(
      (path) => JSON.stringify(path) === JSON.stringify(itemsPath),
    )
  )
    fail("learn_compile_items_path");
  const array = readShape(template.shape, itemsPath),
    items = array !== null && array.kind === "array" ? array.items : null,
    idNode =
      typeof raw.idField === "string" &&
      NAME.test(raw.idField) &&
      isRecord(items)
        ? readShape(items, [raw.idField])
        : null;
  if (
    idNode === null ||
    !(
      (idNode.kind === "string" && ID_CLASSES.has(idNode.class)) ||
      (idNode.kind === "number" && idNode.class === "int")
    )
  )
    fail("learn_compile_id_field");
  const { path, params } = fillSlots(
    template.template,
    slots.templates?.[template.ref] ?? [],
  );
  const forEach = raw.forEach ?? null,
    collectAs = raw.collectAs ?? null;
  if (
    forEach !== null &&
    (typeof forEach !== "string" ||
      !NAME.test(forEach) ||
      !produced.has(forEach))
  )
    fail("learn_compile_for_each");
  if (
    collectAs !== null &&
    (typeof collectAs !== "string" ||
      !NAME.test(collectAs) ||
      produced.has(collectAs))
  )
    fail("learn_compile_collect_as");
  if (params !== (forEach === null ? 0 : 1)) fail("learn_compile_for_each");
  return {
    id: raw.entityType,
    entityType: raw.entityType,
    method: template.method,
    template: path,
    itemsPath,
    idField: raw.idField,
    collectAs,
    forEach,
    pagination: compilePagination(raw.pagination, template),
  };
}
// Longest common LITERAL prefix of the filled step paths, never reaching a
// parameter and never consuming the last segment of any path.
function commonPrefix(paths) {
  const split = paths.map((path) => path.split("/").slice(1)),
    limit = Math.min(...split.map((segments) => segments.length)) - 1,
    prefix = [];
  for (let index = 0; index < limit; index += 1) {
    const segment = split[0][index];
    if (
      PARAM.test(segment) ||
      split.some((segments) => segments[index] !== segment)
    )
      break;
    prefix.push(segment);
  }
  return prefix;
}
function compileHeaders(digest, slots) {
  const raw = isRecord(digest.constantHeaders) ? digest.constantHeaders : {},
    headers = {};
  for (const name of Object.keys(raw).sort(compareText)) {
    const value = HEADER_SLOT.test(raw[name])
      ? slots.headers?.[name]
      : raw[name];
    if (
      !HEADER_TOKEN.test(name) ||
      isCredentialKey(name) ||
      typeof value !== "string" ||
      !PRINTABLE_ASCII.test(value)
    )
      fail("learn_compile_header");
    headers[name] = value;
  }
  return headers;
}
export function compileLearnedBlueprint(input) {
  if (!isRecord(input)) fail("learn_compile_invalid_hints");
  const { digest, hints, authorizedOrigin } = input,
    slots = isRecord(input.slots) ? input.slots : {};
  if (typeof authorizedOrigin !== "string" || !safeOrigin(authorizedOrigin))
    fail("learn_compile_invalid_origin");
  const byRef = templateIndex(digest);
  if (
    digest.sourcePlatform !== new URL(authorizedOrigin).hostname.toLowerCase()
  )
    fail("learn_compile_invalid_digest");
  if (
    !isRecord(hints) ||
    !Array.isArray(hints.steps) ||
    hints.steps.length === 0 ||
    hints.steps.length > MAX_STEPS
  )
    fail("learn_compile_invalid_hints");
  const produced = new Set(),
    steps = [];
  for (const raw of hints.steps) {
    const step = compileStep(raw, byRef, slots, produced);
    if (steps.some((other) => other.entityType === step.entityType))
      fail("learn_compile_entity_type");
    if (step.collectAs !== null) produced.add(step.collectAs);
    steps.push(step);
  }
  const prefix = commonPrefix(steps.map((step) => step.template)),
    blueprint = {
      platform: digest.sourcePlatform,
      apiBase: `${authorizedOrigin}${prefix.map((segment) => `/${segment}`).join("")}`,
      rateLimitMs: LEARNED_RATE_LIMIT_MS,
      headers: compileHeaders(digest, slots),
      budgets: { ...DEFAULT_BUDGETS },
      steps: steps.map((step) => ({
        ...step,
        template: `/${step.template
          .split("/")
          .slice(1 + prefix.length)
          .join("/")}`,
      })),
    };
  try {
    return normalizeBlueprint(blueprint, {
      allowedOrigins: [authorizedOrigin],
    });
  } catch (error) {
    fail("learn_compile_rejected", error);
  }
}
// Factory for X1's vendor-free registry: `register(matches, factory)`. It
// compiles eagerly, so an unusable package throws here and nothing is ever
// registered; every call returns a fresh copy for the run.
export function learnedRegistration(input) {
  const compiled = compileLearnedBlueprint(input),
    origin = input.authorizedOrigin;
  return {
    matches: (candidate) => candidate === origin,
    factory: () => structuredClone(compiled),
  };
}
