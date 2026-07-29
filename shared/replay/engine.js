// Site-agnostic bounded autonomous replay engine (docs/AUTO_DISCOVERY.md §2
// Layer 3). Given a declarative PlatformBlueprint + injected IO, it autonomously
// walks MANY pages under the coach's own session and emits the LOCKED
// _interface.js envelope { sourceId, sourcePlatform, capturedAt, payload }. It
// contains NO competitor-specific knowledge and makes NO chrome.* calls: every
// side effect (fetch, emit, pace, clock) is injected, so the engine is a pure,
// browser-independent, fully-testable unit.
//
// Safety invariants (all enforced here, all tested):
//   - Finite per-request timeout + bounded retry (delegated to injected fetchJson).
//   - Bounded page + entity budgets (blueprint.budgets) -> terminates on any input.
//   - Per-CONTEXT visited-URL set -> cursor/page cycles cannot loop, while two
//     steps (or two fan-out parents) that legitimately share an endpoint URL each
//     still execute. Cross-context idempotency is the emitted-set's job, not this.
//   - Backpressure: emit() is awaited before the next fetch, so entities never
//     buffer unbounded in memory (fetch rate is coupled to ingest rate).
//   - Idempotent within a context: emits are de-duped by (step, context, sourceId)
//     so a retried/replayed page never double-emits, while a child id that is only
//     unique within its parent is NOT collapsed across different parents.
//   - Fail closed on auth loss (401/403 -> AuthLostError, no further requests).
//   - Safe methods only (GET|HEAD, guaranteed by blueprint normalization).
//   - SSRF confinement: the REQUIRED allowedOrigins capability is threaded into
//     normalizeBlueprint, so an off-allowlist apiBase fails closed BEFORE any fetch.
//   - Abort: a signalled abort stops promptly with a cancelled result.

import { normalizeBlueprint, extractItems, readPath, PARAM_NAME_CHARS } from "./blueprint.js";
import { isTimeout } from "../net.js";

export class AuthLostError extends Error {
    constructor(message = "auth_required") {
        super(message);
        this.name = "AuthLostError";
    }
}
export class AbortError extends Error {
    constructor(message = "aborted") {
        super(message);
        this.name = "AbortError";
    }
}
export function isAuthLost(err) {
    return err instanceof Error && err.name === "AuthLostError";
}
export function isAborted(err) {
    return err instanceof Error && err.name === "AbortError";
}

const DEFAULT_MAX_ATTEMPTS = 3;
// Deterministic backoff: base * 2^(attempt-1), no jitter. Jitter would make the
// delay sequence untestable, and the walk is already serialized behind pace() so
// there is no thundering herd to spread out.
export const DEFAULT_BACKOFF_BASE_MS = 500;
// Deliberately well under MV3's ~30s idle-termination threshold: a worker asleep
// in backoff has no pending fetch keeping it alive, and a kill mid-run leaves the
// intent unsettled — the exact "running forever" failure this rung exists to fix.
export const MAX_BACKOFF_MS = 10000;

function isRetryable(err) {
    if (isTimeout(err)) {
        return true;
    }
    // HttpError carries a numeric status. 429 is the source asking us to slow
    // down — retryable, and the one 4xx that is. 5xx is transient; every other
    // 4xx (auth is handled separately) is not.
    if (err instanceof Error && typeof err.status === "number") {
        return err.status === 429 || err.status >= 500;
    }
    return err instanceof Error && err.name !== "MalformedResponseError";
}

// How long to wait before the next attempt. A server-supplied Retry-After wins
// when present (already clamped at parse time), otherwise exponential backoff.
// Both are capped at MAX_BACKOFF_MS so no response can stall the run unboundedly.
export function backoffDelayMs(err, attempt, baseMs = DEFAULT_BACKOFF_BASE_MS) {
    const hinted = err instanceof Error && typeof err.retryAfterMs === "number" && err.retryAfterMs >= 0
        ? err.retryAfterMs
        : null;
    const delay = hinted !== null ? hinted : baseMs * 2 ** (attempt - 1);
    return Math.min(delay, MAX_BACKOFF_MS);
}

// Fill :params in a template with a single id value (generic: every :param in a
// forEach step is filled from the same collected id). The param grammar is the
// SAME canonical char class the normalizer detects with (PARAM_NAME_CHARS), so
// every template the blueprint accepts — including digit-led names like ":1" — is
// actually substituted here; one source of truth, no drift.
const PARAM_TOKEN = new RegExp(`:[${PARAM_NAME_CHARS}]+`, "g");
function fillTemplate(template, id) {
    if (id === null || id === undefined) {
        return template;
    }
    return template.replace(PARAM_TOKEN, encodeURIComponent(String(id)));
}

function buildUrl(apiBase, path, query) {
    const url = new URL(`${apiBase}${path}`);
    if (query) {
        for (const [k, v] of Object.entries(query)) {
            url.searchParams.set(k, String(v));
        }
    }
    return url.toString();
}

export async function runReplay(options) {
    const {
        blueprint,
        fetchJson,
        emit,
        onProgress = () => {},
        signal = null,
        now = () => Date.now(),
        sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
        allowedOrigins,
    } = options;

    // Thread the REQUIRED allowedOrigins SSRF capability into normalization; a
    // missing/empty/off-allowlist origin throws HERE, before any network call.
    const bp = normalizeBlueprint(blueprint, { allowedOrigins });
    const { budgets } = bp;

    const idSets = new Map(); // collectAs -> ordered unique id[]
    const emitted = new Set(); // (step, context, sourceId) tuple (idempotency)
    const progress = bp.steps.map((s) => ({ entityType: s.entityType, sent: 0 }));
    const stepPages = bp.steps.map(() => 0); // pages fetched per step (aggregate)
    let totalPages = 0;
    let totalEntities = 0;
    let truncated = false; // a budget / per-step page cap cut the walk short
    let degraded = false; // at least one page was skipped (malformed / retries exhausted)
    let lastSkipStatus = null; // status/category of the last skipped page (diagnostic only, no body)

    // Per-entity totals for the terminal settlement. Two steps may legitimately
    // feed the same entityType, so they are summed. Built through a Map so an
    // entityType of "__proto__" becomes a real own property instead of silently
    // dropping its count.
    function entityCounts() {
        const totals = new Map();
        for (const row of progress) {
            totals.set(row.entityType, (totals.get(row.entityType) ?? 0) + row.sent);
        }
        return Object.fromEntries(totals);
    }

    const abortedNow = () => signal !== null && signal.aborted === true;
    const budgetLeft = () => totalPages < budgets.maxPages && totalEntities < budgets.maxEntities;
    let lastRequestAt = 0;

    async function pace() {
        if (bp.rateLimitMs <= 0) {
            return;
        }
        const wait = bp.rateLimitMs - (now() - lastRequestAt);
        if (wait > 0) {
            await sleep(wait);
        }
        lastRequestAt = now();
    }

    // One request with bounded retry. Returns the parsed body, or null when the
    // page should be skipped (malformed or retries exhausted). Throws AuthLost /
    // Abort to stop the whole run.
    async function fetchPage(url, method, headers) {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (abortedNow()) {
                throw new AbortError();
            }
            await pace();
            try {
                return await fetchJson(url, { method, headers, signal, timeoutMs: budgets.requestTimeoutMs });
            }
            catch (err) {
                if (isAuthLost(err)) {
                    throw err; // fail closed — never continue after auth loss
                }
                if (isAborted(err) || abortedNow()) {
                    throw new AbortError();
                }
                if (err instanceof Error && err.name === "MalformedResponseError") {
                    lastSkipStatus = "malformed";
                    return null; // shape-shifted/garbage page — skip, do not retry
                }
                if (attempt >= maxAttempts || !isRetryable(err)) {
                    // Preserve the failure status/category (never a body) so a 5xx is diagnosable.
                    lastSkipStatus = typeof err.status === "number"
                        ? err.status
                        : (err instanceof Error ? err.name : "error");
                    return null; // give up on this page; the run stays bounded
                }
                // Transient — wait, then retry. Backing off matters most for 429:
                // retrying a rate-limit immediately just burns the remaining
                // attempts and can escalate the source's throttling.
                await sleep(backoffDelayMs(err, attempt, backoffBaseMs));
            }
        }
        return null;
    }

    function nextIdSet(name) {
        const existing = idSets.get(name);
        if (existing) {
            return existing;
        }
        const created = [];
        idSets.set(name, created);
        return created;
    }

    // A context = one step under one fan-out parent id (null for a non-forEach
    // step). ctxLabel discriminates the context in dedupe keys and synthetic ids.
    async function runContext(step, stepIndex, id) {
        const collect = step.collectAs !== null ? nextIdSet(step.collectAs) : null;
        const collectSeen = collect !== null ? new Set(collect) : null;
        // Effective request headers: blueprint-level defaults, then step headers
        // override per key. This is DATA-only; the trusted source-fetch layer still
        // applies the bearer Authorization LAST, so a step can override any
        // non-auth header but can never spoof Authorization.
        const headers = { ...bp.headers, ...step.headers };
        const ctxLabel = id === null || id === undefined ? "_" : String(id);
        const path = fillTemplate(step.template, id);
        const pag = step.pagination;
        // visited is PER CONTEXT: it breaks intra-context cursor/page cycles but
        // never suppresses a legitimate same-URL fetch by another step/parent.
        const visited = new Set();
        let pageParam = pag !== null && pag.style === "page" ? pag.start : null;
        let cursor = null;
        let pageOrdinal = 0;

        for (;;) {
            if (abortedNow()) {
                throw new AbortError();
            }
            if (!budgetLeft() || stepPages[stepIndex] >= budgets.maxPagesPerStep) {
                truncated = true;
                return;
            }
            const query = {};
            if (pag !== null && pag.style === "page") {
                query[pag.param] = pageParam;
            }
            if (pag !== null && pag.style === "cursor" && cursor !== null) {
                query[pag.param] = cursor;
            }
            const url = buildUrl(bp.apiBase, path, query);
            if (visited.has(url)) {
                return; // duplicate page / cursor cycle within this context — stop
            }
            visited.add(url);
            totalPages += 1;
            stepPages[stepIndex] += 1;
            const thisPage = pageOrdinal;
            pageOrdinal += 1;

            const body = await fetchPage(url, step.method, headers);
            if (body === null) {
                degraded = true; // a page was skipped — the walk is no longer whole
            }
            const items = body === null ? [] : extractItems(body, step.itemsPath);

            const capturedAt = new Date(now()).toISOString();
            const batch = [];
            items.forEach((item, index) => {
                const rawId = item && typeof item === "object" ? item[step.idField] : undefined;
                // Real id when present; otherwise a URL-FREE, bounded, deterministic
                // synthetic (step + context + page + index) — never the request URL,
                // so no cursor/query token is persisted into a stored sourceId.
                const sourceId = rawId === undefined || rawId === null
                    ? `${step.id}#${ctxLabel}#${thisPage}#${index}`
                    : String(rawId);
                // Dedupe on a structured (step, context, sourceId) tuple. Context is
                // the fan-out parent, so a child id unique only within its parent is
                // kept distinct across parents; a JSON tuple also cannot collide
                // across the field boundary the way a delimiter-joined string can.
                const key = JSON.stringify([step.id, ctxLabel, sourceId]);
                if (emitted.has(key)) {
                    return; // already emitted in this context — idempotent
                }
                emitted.add(key);
                batch.push({ sourceId, sourcePlatform: bp.platform, capturedAt, payload: item });
                if (collect !== null && rawId !== undefined && rawId !== null && !collectSeen.has(sourceId)) {
                    collectSeen.add(sourceId);
                    collect.push(sourceId);
                }
            });
            if (batch.length > 0) {
                await emit(step.entityType, batch); // awaited => backpressure
                totalEntities += batch.length;
                progress[stepIndex].sent += batch.length;
                onProgress(progress.map((p) => ({ ...p })));
            }

            // Advance pagination or terminate this context.
            if (pag === null) {
                return; // single, un-paginated page
            }
            if (pag.style === "page") {
                if (items.length === 0) {
                    return; // empty page => end of list
                }
                pageParam += 1;
                continue;
            }
            // cursor
            const nextCursor = body === null ? undefined : readPath(body, pag.nextPath);
            if (typeof nextCursor !== "string" || nextCursor.length === 0) {
                return; // no further cursor => end of list
            }
            cursor = nextCursor;
        }
    }

    try {
        for (let i = 0; i < bp.steps.length; i += 1) {
            const step = bp.steps[i];
            if (abortedNow()) {
                throw new AbortError();
            }
            if (step.forEach === null) {
                await runContext(step, i, null);
            }
            else {
                // Snapshot the parent id set: a self-referential forEach cannot grow
                // its own iteration mid-walk (the normalizer also rejects it).
                const ids = [...(idSets.get(step.forEach) ?? [])];
                for (const id of ids) {
                    await runContext(step, i, id);
                    if (!budgetLeft()) {
                        truncated = true;
                        break;
                    }
                }
            }
        }
    }
    catch (err) {
        // Abort is a normal terminal outcome (coach cancelled / auth lost upstream
        // triggered an abort); auth loss must propagate so the caller fails closed.
        if (isAborted(err)) {
            return { status: "cancelled", pages: totalPages, entities: totalEntities, counts: entityCounts(), truncated, degraded, lastSkipStatus };
        }
        throw err;
    }

    // Honest terminal status: a skipped page or a budget-truncated walk is NOT an
    // ordinary "complete". If pages were skipped and nothing was emitted at all the
    // run could not produce data (failed); if it degraded or was truncated but still
    // emitted something it is partial.
    //
    // A clean walk yielding ZERO entities is its own outcome ("empty"), never
    // "complete": nothing looks wrong, but the likely cause is blueprint drift, and
    // "import complete, 0 records" is indistinguishable from "you have no clients".
    // "empty" forces that distinction to be verified instead of swallowed.
    let status;
    if (degraded && totalEntities === 0) {
        status = "failed";
    }
    else if (degraded || truncated) {
        status = "partial";
    }
    else if (totalEntities === 0) {
        status = "empty";
    }
    else {
        status = "complete";
    }
    return { status, pages: totalPages, entities: totalEntities, counts: entityCounts(), truncated, degraded, lastSkipStatus };
}
