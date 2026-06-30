// Runtime networking + date-window helpers for the TrueCoach extractor.
// Kept separate from the pure parsers so the parse layer stays DOM/fetch-free.
import { TRUECOACH_API_BASE } from "../../shared/protocol.js";
export const RATE_LIMIT_MS = 500; // ~2 requests/second
export const CLIENTS_PER_PAGE = 25;
export const WORKOUTS_PER_PAGE = 1000;
// Workouts paginate by DATE WINDOW, not page number. Walk backwards in
// fixed-size windows from today; stop after a run of empty windows; never look
// further back than the hard floor. All three are configurable constants.
export const WINDOW_DAYS = 90;
export const EMPTY_WINDOW_STOP = 2; // stop after this many consecutive empties
export const MAX_LOOKBACK_DAYS = 365 * 5; // hard floor: 5 years
function toIsoDate(d) {
    return d.toISOString().slice(0, 10);
}
// Produce the descending list of windows to query, newest first. Pure so the
// walk's stop logic can be unit-tested without a clock or network.
export function buildDateWindows(today, windowDays = WINDOW_DAYS, maxLookbackDays = MAX_LOOKBACK_DAYS) {
    const windows = [];
    const floor = new Date(today.getTime() - maxLookbackDays * 86400000);
    let end = new Date(today.getTime());
    while (end.getTime() >= floor.getTime()) {
        const start = new Date(end.getTime() - (windowDays - 1) * 86400000);
        const clampedStart = start.getTime() < floor.getTime() ? floor : start;
        windows.push({ startDate: toIsoDate(clampedStart), endDate: toIsoDate(end) });
        end = new Date(clampedStart.getTime() - 86400000);
    }
    return windows;
}
export function workoutsPath(clientId, w) {
    return (`/clients/${clientId}/workouts?client_id=${clientId}` +
        `&start_date=${w.startDate}&end_date=${w.endDate}` +
        `&limit=${WORKOUTS_PER_PAGE}&order=due:asc`);
}
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error("aborted"));
            return;
        }
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
        });
    });
}
export function authHeaders(token) {
    // Header pattern verified in go-truecoach http.go transport.RoundTrip.
    return {
        Authorization: `Bearer ${token}`,
        Role: "Trainer",
        Accept: "application/json, text/html",
    };
}
async function rawFetch(path, token, signal, rateMs = RATE_LIMIT_MS) {
    await sleep(rateMs, signal);
    const res = await fetch(`${TRUECOACH_API_BASE}${path}`, {
        method: "GET",
        headers: authHeaders(token),
        credentials: "include",
        signal,
    });
    if (!res.ok) {
        throw new Error(`GET ${path} -> ${res.status}`);
    }
    return res;
}
export async function getJson(path, token, signal, rateMs = RATE_LIMIT_MS) {
    return (await rawFetch(path, token, signal, rateMs)).json();
}
// Used for the /goal endpoint, which may return text/html (HTMX) or JSON. The
// caller branches on contentType to decide DOMParser vs JSON.parse.
export async function getBody(path, token, signal, rateMs = RATE_LIMIT_MS) {
    const res = await rawFetch(path, token, signal, rateMs);
    return { contentType: res.headers.get("content-type"), body: await res.text() };
}
