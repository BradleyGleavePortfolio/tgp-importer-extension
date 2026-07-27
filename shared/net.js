// TGP Importer — finite-timeout fetch wrapper.
//
// Every network call the extension makes MUST be bounded: an MV3 service worker
// that awaits a hung fetch can stall the auth path (refresh) or leave the coach
// staring at a spinner (pair redeem) with no error. This races the fetch against
// a deadline, aborts the request when the deadline fires (best-effort, via
// AbortController), and rejects with a tagged TimeoutError so callers can map a
// timeout to distinct user-visible copy. The timer is always cleared.
//
// Caller-supplied init.signal is composed, not dropped: abort from either the
// timeout controller OR the caller's signal cancels the underlying fetch.
export const DEFAULT_TIMEOUT_MS = 15000;

export function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const callerSignal = init && init.signal ? init.signal : null;
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
        if (callerSignal.aborted) {
            controller.abort();
        }
        else {
            callerSignal.addEventListener("abort", onCallerAbort, { once: true });
        }
    }
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            const err = new Error("fetch_timeout");
            err.name = "TimeoutError";
            reject(err);
        }, timeoutMs);
    });
    // Strip caller signal so we own the one signal handed to fetchImpl.
    const { signal: _ignored, ...rest } = init || {};
    return Promise.race([
        fetchImpl(url, { ...rest, signal: controller.signal }),
        timeout,
    ]).finally(() => {
        clearTimeout(timer);
        if (callerSignal) {
            callerSignal.removeEventListener("abort", onCallerAbort);
        }
    });
}

export function isTimeout(err) {
    return err instanceof Error && err.name === "TimeoutError";
}

// Upper bound on any server-supplied Retry-After. A hostile or misconfigured
// source can send "Retry-After: 86400"; honouring it would park an MV3 worker
// for a day. Clamp at parse time so no caller can forget to bound it.
export const MAX_RETRY_AFTER_MS = 60000;

// Parse an HTTP Retry-After header into a bounded, non-negative millisecond
// delay. Both RFC 9110 forms are accepted: delta-seconds and HTTP-date. Returns
// null when the header is absent or unparseable, so the caller falls back to its
// own deterministic backoff rather than retrying instantly.
export function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
    if (typeof headerValue !== "string") {
        return null;
    }
    const raw = headerValue.trim();
    if (raw.length === 0) {
        return null;
    }
    if (/^\d+$/.test(raw)) {
        const ms = Number(raw) * 1000;
        return Number.isFinite(ms) ? Math.min(ms, MAX_RETRY_AFTER_MS) : null;
    }
    // Every HTTP-date form begins with a day name, so anything else that is not
    // pure digits is malformed. Without this, Date.parse happily reads "-5" and
    // "1.5" as years and turns an invalid header into a real delay.
    if (!/^[A-Za-z]/.test(raw)) {
        return null;
    }
    const at = Date.parse(raw);
    if (Number.isNaN(at)) {
        return null;
    }
    // A date already in the past means "retry now", not "retry in the past".
    return Math.min(Math.max(at - nowMs, 0), MAX_RETRY_AFTER_MS);
}

// Read a header off a Response-like object without assuming a real Headers
// instance (the extension's own tests and non-Chromium hosts may hand back a
// plain object).
export function readHeader(res, name) {
    const headers = res && typeof res === "object" ? res.headers : null;
    if (headers === null || typeof headers !== "object" || typeof headers.get !== "function") {
        return null;
    }
    const value = headers.get(name);
    return typeof value === "string" ? value : null;
}
