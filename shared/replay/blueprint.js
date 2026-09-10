// PlatformBlueprint — the declarative, SITE-AGNOSTIC contract the replay engine
// consumes (docs/AUTO_DISCOVERY.md §2 Layer 2/3). It contains NO executable code
// and NO competitor-specific logic: only endpoint roles, id fields, pagination
// descriptors, and fan-out edges expressed as data. Blueprints are produced by a
// verification adapter today and by auto-inference (PR-C2) next; the engine does
// not care which.
//
// Shape (all keys optional unless noted):
//   {
//     platform: "<platform-id>",              // provenance label only (REQUIRED)
//     apiBase:  "https://host/base",          // absolute origin+base (REQUIRED)
//     rateLimitMs: 500,                        // min interval between requests
//     headers: { "Accept": "application/json" }, // request headers for EVERY step
//     budgets: { maxPages, maxEntities, maxPagesPerStep, requestTimeoutMs },
//     steps: [ Step, ... ]                     // ordered; >=1 (REQUIRED)
//   }
//   Step = {
//     id: "list",                              // unique within blueprint (REQUIRED)
//     entityType: "record",                    // envelope entity_type (REQUIRED)
//     method: "GET",                           // GET|HEAD only (default GET)
//     template: "/records" | "/records/:id",   // path; :params filled per-item (REQUIRED)
//     itemsPath: ["records"],                  // path to the array in the body; [] = body is array
//     idField: "id",                           // field on each item used as source_id + collected id
//     collectAs: "recordIds",                  // store item ids under this set name
//     forEach: "recordIds",                    // fan out: one request per id in this set
//     headers: { "X-Requested-With": "xhr" },  // per-step headers; override blueprint headers
//     pagination: { style: "page"|"cursor", param, start, nextPath } | null
//   }
//
// normalizeBlueprint(bp, opts) fills defaults and validates; it throws on a
// structurally invalid or unsafe blueprint so a bad descriptor fails closed
// BEFORE any network call. Blueprints are auto-inferred from UNTRUSTED capture
// (PR-C2), so the normalizer confines WHERE the crawl may go: https only, no
// IP-literal loopback/link-local/localhost host, no embedded credentials, and —
// REQUIRED — the caller must inject a non-empty `opts.allowedOrigins` capability
// the apiBase origin must exactly match. A parse-time gate cannot prove a NAME
// will not resolve to a private target, so name-resolution confinement is
// delegated to that allowlist: only an origin the trusted caller observed passes.
// Step templates must be root-relative, so no step can redirect off-origin. The
// core stays SITE-AGNOSTIC: the allowlist is injected (PR-C1b), never hardcoded.

const SAFE_METHODS = new Set(["GET", "HEAD"]);

// Canonical :param name grammar — a colon followed by one or more of these chars
// (digit-led names like ":1" included). This is the SINGLE source of truth: the
// normalizer's presence check below AND the engine's substitution both build from
// it, so a template this file accepts is exactly a template the engine fills.
export const PARAM_NAME_CHARS = "A-Za-z0-9_";

// Hosts refused outright as apiBase OR as an allowed origin: IP literals (rejected
// wholesale — blueprints address hosts by name) and loopback/link-local/localhost,
// the classic SSRF pivots. This is a resolve-free, name-literal check; a NAME that
// resolves to a private target cannot be caught here, which is why a non-empty
// allowedOrigins capability is REQUIRED below (name-resolution confinement).
const IPV4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// Header confinement char classes (see normalizeHeaders). Values reject C0/DEL
// (the CR/LF/NUL request-splitting vector); names reject the same PLUS backslash
// (not a valid RFC 7230 field-name token char).
const HEADER_VALUE_FORBIDDEN = /[\x00-\x1F\x7F]/;
const HEADER_NAME_FORBIDDEN = /[\x00-\x1F\x7F\\]/;

function isForbiddenHost(hostname) {
  // Lower-case and strip ALL trailing dots: "localhost.", "localhost..", and
  // "svc.localhost.." are fully-qualified spellings of the same target and must
  // be judged by the same rule. WHATWG URL has already IDNA-normalized hostname,
  // so fullwidth/homoglyph "localhost" arrives here as "localhost".
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  if (host.startsWith("[")) {
    return true; // any IPv6 literal (incl. [::1], [fe80::…])
  }
  return IPV4_LITERAL.test(host); // any IPv4 literal (loopback/link-local/private/public)
}

// Validate a URL's scheme/credentials/host confinement and return the URL object.
// Shared by apiBase AND every allowed-origin entry, so the allowlist itself cannot
// smuggle in an http/credentialed/loopback/IP-literal target.
function assertSafeUrl(raw, label) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} "${raw}" is not an absolute URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} "${raw}" must use https (got "${url.protocol}")`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${label} "${raw}" must not embed credentials`);
  }
  if (isForbiddenHost(url.hostname)) {
    throw new Error(
      `${label} host "${url.hostname}" is not an allowed target (IP literal / loopback / link-local)`,
    );
  }
  return url;
}

// The caller MUST inject a NON-EMPTY allowedOrigins capability. A parse-time gate
// cannot prove a hostname will not resolve to a private/link-local target (no DNS),
// so the only safe rule is: a crawl may reach exactly the origins the trusted
// caller explicitly observed. Absence/empty fails closed BEFORE any network call.
// The allowlist is injected (site-agnostic) — never a hardcoded competitor map.
function normalizeAllowedOrigins(opts) {
  const raw = isRecord(opts) ? opts.allowedOrigins : undefined;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isNonEmptyString)) {
    throw new Error(
      "allowedOrigins must be a non-empty string[] of https origins",
    );
  }
  const set = new Set();
  for (const o of raw) {
    set.add(assertSafeUrl(o, "allowedOrigins entry").origin);
  }
  return set;
}

// Validate the apiBase and require its exact origin be on the allowlist.
function assertSafeApiBase(apiBase, allowedOrigins) {
  const url = assertSafeUrl(apiBase, "blueprint.apiBase");
  if (!allowedOrigins.has(url.origin)) {
    throw new Error(
      `blueprint.apiBase origin "${url.origin}" is not in the allowed-origins allowlist`,
    );
  }
  return url.origin;
}

export const DEFAULT_BUDGETS = Object.freeze({
  maxPages: 2000,
  maxPagesPerStep: 1000,
  maxEntities: 200000,
  requestTimeoutMs: 15000,
});
export const HARD_BUDGETS = Object.freeze({
  maxPages: 5000,
  maxPagesPerStep: 2000,
  maxEntities: 500000,
  requestTimeoutMs: 60000,
  rateLimitMs: 60000,
});

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// Normalize an optional headers descriptor to a plain Record<string,string>.
// Absent (undefined/null) => {}. A present value MUST be a plain object whose
// every key AND value is a non-empty string; anything else fails closed. Headers
// are adapter DATA (auto-inferred from UNTRUSTED capture in PR-C2), so — mirroring
// the template guard above — a control character or malformed name is rejected
// here rather than silently shipped to fetch.
//
// Injection confinement (simplest rule consistent with HTTP header grammar):
//   - NAMES and VALUES may never contain a C0 control or DEL (/[\x00-\x1F\x7F]/).
//     CR/LF/NUL are the header-splitting / request-smuggling vector; DEL and the
//     other C0s are illegal in both field-names and field-values regardless.
//   - NAMES additionally reject backslash: a field-name is an RFC 7230 `token`, and
//     "\" is not a token char (this also matches the template rule's backslash ban).
//     VALUES keep backslash — it is a legal, common field-content byte (User-Agent,
//     filenames), so banning it there would reject real headers with no safety gain.
// Note: Authorization is applied LAST by the trusted source-fetch layer, so a
// blueprint cannot spoof it even by declaring an "Authorization" header.
function normalizeHeaders(h, label) {
  if (h === undefined || h === null) {
    return {};
  }
  if (!isRecord(h)) {
    throw new Error(`${label} headers must be a plain object`);
  }
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (!isNonEmptyString(k)) {
      throw new Error(`${label} header name must be a non-empty string`);
    }
    if (HEADER_NAME_FORBIDDEN.test(k)) {
      throw new Error(
        `${label} header name "${k}" must not contain control characters or backslashes`,
      );
    }
    if (!isNonEmptyString(v)) {
      throw new Error(
        `${label} header "${k}" value must be a non-empty string`,
      );
    }
    if (HEADER_VALUE_FORBIDDEN.test(v)) {
      throw new Error(
        `${label} header "${k}" value must not contain control characters`,
      );
    }
    out[k] = v;
  }
  return out;
}

// An ABSENT pagination field means "the producer had nothing to say" and keeps the
// documented default. A PRESENT but malformed field means the producer emitted
// something this contract cannot execute; since descriptors are inferred from
// UNTRUSTED capture (PR-C2), coercing it (unknown style ⇒ `page`, empty param ⇒
// "page", fractional start ⇒ 1) would manufacture runnable traversal nobody proved.
// So: absent defaults; present-but-invalid throws before replay ever sees the step.
const isAbsent = (v) => v === undefined || v === null;

function normalizePagination(p, stepId) {
  if (p === undefined || p === null) {
    return null;
  }
  if (!isRecord(p)) {
    throw new Error(
      `blueprint step "${stepId}": pagination must be an object or null`,
    );
  }
  if (!isAbsent(p.style) && p.style !== "page" && p.style !== "cursor") {
    throw new Error(
      `blueprint step "${stepId}": pagination style must be "page" or "cursor"`,
    );
  }
  const style = p.style === "cursor" ? "cursor" : "page";
  // `param` is the query key the engine writes the page/cursor value to.
  if (!isAbsent(p.param) && !isNonEmptyString(p.param)) {
    throw new Error(
      `blueprint step "${stepId}": pagination param must be a non-empty string`,
    );
  }
  if (style === "page") {
    const param = isAbsent(p.param) ? "page" : p.param;
    if (!isAbsent(p.start) && !Number.isInteger(p.start)) {
      throw new Error(
        `blueprint step "${stepId}": page pagination start must be an integer`,
      );
    }
    const start = isAbsent(p.start) ? 1 : p.start;
    return { style, param, start };
  }
  // cursor: `param` carries the next cursor on the query string; `nextPath`
  // locates the next-cursor token in the response body. An absent, empty, or
  // malformed nextPath ⇒ the engine cannot advance (an empty path reads the whole
  // body, never a token) — caught here rather than looping forever.
  if (
    !Array.isArray(p.nextPath) ||
    p.nextPath.length === 0 ||
    !p.nextPath.every(isNonEmptyString)
  ) {
    throw new Error(
      `blueprint step "${stepId}": cursor pagination requires a non-empty nextPath string[]`,
    );
  }
  const param = isAbsent(p.param) ? "cursor" : p.param;
  return { style, param, nextPath: [...p.nextPath] };
}

function normalizeStep(step, seenIds) {
  if (!isRecord(step)) {
    throw new Error("blueprint step must be an object");
  }
  if (!isNonEmptyString(step.id)) {
    throw new Error("blueprint step requires a non-empty id");
  }
  if (seenIds.has(step.id)) {
    throw new Error(`blueprint step id "${step.id}" is duplicated`);
  }
  seenIds.add(step.id);
  if (!isNonEmptyString(step.entityType)) {
    throw new Error(`blueprint step "${step.id}": entityType is required`);
  }
  if (!isNonEmptyString(step.template)) {
    throw new Error(`blueprint step "${step.id}": template is required`);
  }
  // A template is a ROOT-RELATIVE path joined onto apiBase; an off-origin
  // template would redirect the credentialed crawl elsewhere. Backslashes alias
  // "/" and C0 controls (TAB/LF/CR) are stripped mid-parse — both escape
  // off-origin past a naive startsWith, so reject them outright, then
  // MECHANICALLY prove the resolved origin is unchanged against a sentinel. A
  // "://" inside a path/query (e.g. "/redirect?url=https://x") stays on-origin
  // under join, so we do NOT blanket-reject it — the sentinel proof is decisive.
  if (/[\\\x00-\x1F\x7F]/.test(step.template)) {
    throw new Error(
      `blueprint step "${step.id}": template must not contain backslashes or control characters`,
    );
  }
  if (!step.template.startsWith("/") || step.template.startsWith("//")) {
    throw new Error(
      `blueprint step "${step.id}": template must be a root-relative path ("/...") with no origin`,
    );
  }
  const SENTINEL = "https://blueprint.invalid";
  let probe;
  try {
    probe = new URL(step.template, SENTINEL + "/");
  } catch {
    throw new Error(
      `blueprint step "${step.id}": template is not a resolvable path`,
    );
  }
  if (probe.origin !== SENTINEL || !probe.href.startsWith(SENTINEL + "/")) {
    throw new Error(
      `blueprint step "${step.id}": template must be a root-relative path ("/...") with no origin`,
    );
  }
  const method = isNonEmptyString(step.method)
    ? step.method.toUpperCase()
    : "GET";
  if (!SAFE_METHODS.has(method)) {
    // Destructive/unsafe methods are refused at parse time (docs/DESIGN.md §7,
    // AUTO_DISCOVERY §9: safe methods only, no destructive requests).
    throw new Error(
      `blueprint step "${step.id}": method "${method}" is not a safe method (GET|HEAD)`,
    );
  }
  const itemsPath =
    Array.isArray(step.itemsPath) && step.itemsPath.every(isNonEmptyString)
      ? [...step.itemsPath]
      : [];
  const idField = isNonEmptyString(step.idField) ? step.idField : "id";
  const forEach = isNonEmptyString(step.forEach) ? step.forEach : null;
  // A :param placeholder is a colon + a name from [A-Za-z0-9_] (digit-led names
  // like ":1" included, so detection is unambiguous). A template with any
  // placeholder must be fed by a forEach set; a bare one must not be. The engine
  // fills placeholders with collected ids and MUST encodeURIComponent each value
  // so it cannot inject "/", "\", "?", "#", or ".." — this file fixes placeholder
  // SYNTAX, the engine owns value ENCODING across the seam (PR-C1a).
  const hasParam = new RegExp(`:[${PARAM_NAME_CHARS}]`).test(step.template);
  if (hasParam && forEach === null) {
    throw new Error(
      `blueprint step "${step.id}": template has a :param but no forEach set to fill it`,
    );
  }
  // A step that fans out over its OWN collected set (collectAs === forEach) would
  // feed each fetched id back into its own iteration — a self-amplifying crawl the
  // budgets bound but never intend. Reject it as structurally invalid up front.
  const collectAs = isNonEmptyString(step.collectAs) ? step.collectAs : null;
  if (forEach !== null && collectAs === forEach) {
    throw new Error(
      `blueprint step "${step.id}": collectAs "${collectAs}" must not equal its own forEach set`,
    );
  }
  return {
    id: step.id,
    entityType: step.entityType,
    method,
    template: step.template,
    itemsPath,
    idField,
    collectAs,
    forEach,
    headers: normalizeHeaders(step.headers, `blueprint step "${step.id}"`),
    pagination: normalizePagination(step.pagination, step.id),
  };
}

function normalizeBudgets(b) {
  if (b === undefined || b === null) {
    return { ...DEFAULT_BUDGETS };
  }
  if (!isRecord(b)) {
    throw new Error("blueprint budgets must be an object");
  }
  const pick = (key) =>
    Number.isInteger(b[key]) && b[key] > 0 && b[key] <= HARD_BUDGETS[key]
      ? b[key]
      : DEFAULT_BUDGETS[key];
  return {
    maxPages: pick("maxPages"),
    maxPagesPerStep: pick("maxPagesPerStep"),
    maxEntities: pick("maxEntities"),
    requestTimeoutMs: pick("requestTimeoutMs"),
  };
}

export function normalizeBlueprint(bp, opts) {
  if (!isRecord(bp)) {
    throw new Error("blueprint must be an object");
  }
  if (!isNonEmptyString(bp.platform)) {
    throw new Error("blueprint.platform is required");
  }
  if (!isNonEmptyString(bp.apiBase)) {
    throw new Error("blueprint.apiBase is required");
  }
  // Confine WHERE the crawl may go (https + host/origin allowlist) before any
  // other work, so an unsafe target fails closed BEFORE a network call.
  const allowedOrigins = normalizeAllowedOrigins(opts);
  assertSafeApiBase(bp.apiBase, allowedOrigins);
  if (!Array.isArray(bp.steps) || bp.steps.length === 0) {
    throw new Error("blueprint.steps must be a non-empty array");
  }
  const seenIds = new Set();
  const steps = bp.steps.map((s) => normalizeStep(s, seenIds));
  // Every forEach must reference a set produced by an EARLIER step's collectAs,
  // so fan-out can never depend on ids that are never collected.
  const produced = new Set();
  for (const step of steps) {
    if (step.forEach !== null && !produced.has(step.forEach)) {
      throw new Error(
        `blueprint step "${step.id}": forEach "${step.forEach}" is not collected by any earlier step`,
      );
    }
    if (step.collectAs !== null) {
      produced.add(step.collectAs);
    }
  }
  const rateLimitMs =
    Number.isFinite(bp.rateLimitMs) &&
    bp.rateLimitMs >= 0 &&
    bp.rateLimitMs <= HARD_BUDGETS.rateLimitMs
      ? bp.rateLimitMs
      : 0;
  return {
    platform: bp.platform,
    apiBase: bp.apiBase.replace(/\/+$/, ""),
    rateLimitMs,
    headers: normalizeHeaders(bp.headers, "blueprint"),
    budgets: normalizeBudgets(bp.budgets),
    steps,
  };
}

// Read a nested value by path (e.g. ["meta","next_cursor"]). Returns undefined if
// any segment is missing or a non-record is traversed. [] returns the value itself.
export function readPath(value, path) {
  let cur = value;
  for (const key of path) {
    if (!isRecord(cur) && !Array.isArray(cur)) {
      return undefined;
    }
    cur = cur[key];
  }
  return cur;
}

// Extract the item array from a list response given itemsPath. Non-arrays yield
// an empty list (a malformed/shape-shifted page contributes nothing, never throws).
export function extractItems(body, itemsPath) {
  const located = itemsPath.length === 0 ? body : readPath(body, itemsPath);
  return Array.isArray(located) ? located : [];
}
