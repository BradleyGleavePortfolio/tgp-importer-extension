// TGP Importer — finite-timeout fetch wrapper.
//
// Every network call the extension makes MUST be bounded: an MV3 service worker
// that awaits a hung fetch can stall the auth path (refresh) or leave the coach
// staring at a spinner (pair redeem) with no error. This races the fetch against
// a deadline, aborts the request when the deadline fires (best-effort, via
// AbortController), and rejects with a tagged TimeoutError so callers can map a
// timeout to distinct user-visible copy. The timer is always cleared.
export const DEFAULT_TIMEOUT_MS = 15000;

export function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            const err = new Error("fetch_timeout");
            err.name = "TimeoutError";
            reject(err);
        }, timeoutMs);
    });
    return Promise.race([
        fetchImpl(url, { ...init, signal: controller.signal }),
        timeout,
    ]).finally(() => clearTimeout(timer));
}

export function isTimeout(err) {
    return err instanceof Error && err.name === "TimeoutError";
}
