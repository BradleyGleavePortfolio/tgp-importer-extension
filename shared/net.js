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
import { logNetworkEvent } from "./log.js";

export const DEFAULT_TIMEOUT_MS = 15000;

// An optional consumer keeps response-body work inside the same deadline. It
// receives the deadline AbortSignal as its second argument so body readers can
// release their stream when the deadline (or the caller) aborts.
/** @param {(response: any, signal: AbortSignal) => any} [consume] */
export function fetchWithTimeout(
  fetchImpl,
  url,
  init = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  consume = (response) => response,
) {
  const controller = new AbortController();
  const callerSignal = init && init.signal ? init.signal : null;
  let timer;
  let onCallerAbort;
  const timeout = new Promise((_resolve, reject) => {
    const interrupt = (name, message) => {
      const err = new Error(message);
      err.name = name;
      reject(err);
      controller.abort();
    };
    onCallerAbort = () => interrupt("AbortError", "aborted");
    timer = setTimeout(() => {
      interrupt("TimeoutError", "fetch_timeout");
    }, timeoutMs);
    if (callerSignal) {
      if (callerSignal.aborted) onCallerAbort();
      else
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  });
  // Strip caller signal so we own the one signal handed to fetchImpl.
  const { signal: _ignored, ...rest } = init || {};
  return Promise.race([
    timeout,
    (async () => {
      controller.signal.throwIfAborted();
      return consume(
        await fetchImpl(url, { ...rest, signal: controller.signal }),
        controller.signal,
      );
    })(),
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

// Upper bound on any authentication response body. A token pair is a few
// kilobytes at most; anything larger is not a token response we should parse.
export const MAX_AUTH_BODY_BYTES = 16384;

// Parse a JSON body INSIDE the caller's deadline, bounded in bytes as well as
// time. Must be called from a fetchWithTimeout consumer so a body that never
// closes is cut off by the same deadline that bounds the headers. Rejects with a
// tagged BodyError on oversize, undecodable or malformed bodies; the error
// never carries response bytes. Falls back to response.json() when the runtime
// exposes no body stream. Aborting `signal` cancels an in-progress read.
/** @param {AbortSignal | null} [signal] */
export async function readBoundedJson(
  response,
  signal = null,
  maxBytes = MAX_AUTH_BODY_BYTES,
) {
  const bodyError = () => {
    const err = new Error("body_invalid");
    err.name = "BodyError";
    return err;
  };
  const body = response && typeof response === "object" ? response.body : null;
  if (
    body === null ||
    body === undefined ||
    typeof body !== "object" ||
    typeof body.getReader !== "function"
  ) {
    try {
      return await response.json();
    } catch {
      throw bodyError();
    }
  }
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {
      logNetworkEvent("auth_body_cancel_failed");
    });
  };
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw bodyError();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch {
    // Never echo response bytes, parser errors or transport diagnostics.
    cancel();
    throw bodyError();
  } finally {
    if (signal) signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

// Request cancellation of a body we will not read (e.g. a non-2xx auth reply)
// so the connection is not left live after the caller has settled. Never
// awaited: a hung cancel must not block the caller. Never throws.
export function discardBody(response) {
  const body = response && typeof response === "object" ? response.body : null;
  if (!body || typeof body !== "object" || typeof body.cancel !== "function") {
    return false;
  }
  try {
    if (body.locked === true) return false;
    void Promise.resolve(body.cancel()).catch(() => {
      logNetworkEvent("auth_body_cancel_failed");
    });
    return true;
  } catch {
    logNetworkEvent("auth_body_cancel_failed");
    return false;
  }
}

// Upper bound on any server-supplied Retry-After. "Retry-After: 86400" would park
// an MV3 worker for a day, so clamp at parse time — no caller can forget to.
export const MAX_RETRY_AFTER_MS = 60000;

// Both RFC 9110 forms (delta-seconds, HTTP-date) into a bounded non-negative ms
// delay. null when absent or unparseable, so the caller falls back to its own
// deterministic backoff rather than retrying instantly.
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

// Read a header without assuming a real Headers instance (tests and non-Chromium
// hosts may hand back a plain object).
export function readHeader(res, name) {
  const headers = res && typeof res === "object" ? res.headers : null;
  if (
    headers === null ||
    typeof headers !== "object" ||
    typeof headers.get !== "function"
  ) {
    return null;
  }
  const value = headers.get(name);
  return typeof value === "string" ? value : null;
}
