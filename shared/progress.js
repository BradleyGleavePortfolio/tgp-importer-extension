// TGP Importer — bounded, monotone progress reporting for POST /api/scout/progress.
//
// The engine's onProgress fires once per emitted batch: far above the backend's
// 240-req/min throttle, and carrying a per-step view that can legitimately go
// backwards between contexts. This adapter enforces both halves of the DTO's
// contract — BOUNDED (one POST per minIntervalMs, never two in flight, capped
// entries, every string clamped to the backend's MaxLength, so a report is never
// throttled or rejected into losing the series) and MONOTONE (count_committed is
// a high-water mark; a backwards count reads as data being lost). Reporting is
// strictly advisory, so nothing here throws. Injected POST, no chrome.* calls.

export const PROGRESS_MAX_ENTRIES = 64; // ScoutProgressDto @ArrayMaxSize(64)
export const PROGRESS_MAX_ENTITY_TYPE = 64; // ScoutProgressEntryDto @MaxLength(64)
export const PROGRESS_MAX_INTENT_ID = 128; // ScoutProgressDto @MaxLength(128)
export const PROGRESS_MAX_DEVICE_ID = 64; // ScoutProgressDto @Length(1, 64)
export const PROGRESS_MAX_ERROR = 2000; // ScoutProgressDto @MaxLength(2000)
// The backend allows 240/min; one per second leaves headroom for retries and for
// the ingest calls sharing the same coach.
export const PROGRESS_MIN_INTERVAL_MS = 1000;

function clampString(value, max) {
    return typeof value === "string" ? value.slice(0, max) : "";
}

export function createProgressReporter(options) {
    const {
        postProgress,
        intentId,
        deviceId,
        minIntervalMs = PROGRESS_MIN_INTERVAL_MS,
        now = () => Date.now(),
    } = options;

    const intent = clampString(intentId, PROGRESS_MAX_INTENT_ID);
    const device = clampString(deviceId, PROGRESS_MAX_DEVICE_ID);
    // entityType -> highest count ever observed. Insertion-ordered, so the
    // PROGRESS_MAX_ENTRIES cap keeps the first entity types seen rather than an
    // arbitrary subset.
    const highWater = new Map();
    let lastSentAt = null;
    // The outstanding POST, or null. Held as a promise rather than a boolean so a
    // forced flush can WAIT for it instead of being dropped.
    let inFlight = null;

    function absorb(rows) {
        if (!Array.isArray(rows)) {
            return;
        }
        for (const row of rows) {
            if (row === null || typeof row !== "object") {
                continue;
            }
            const key = clampString(row.entityType, PROGRESS_MAX_ENTITY_TYPE);
            if (key.length === 0) {
                continue;
            }
            const sent = Number.isInteger(row.sent) && row.sent >= 0 ? row.sent : 0;
            const previous = highWater.get(key) ?? 0;
            highWater.set(key, Math.max(previous, sent));
        }
    }

    function snapshot() {
        return [...highWater.entries()]
            .slice(0, PROGRESS_MAX_ENTRIES)
            .map(([entityType, count]) => ({
                entity_type: entityType,
                count_committed: count,
                // The crawl discovers pages as it walks, so no true total exists
                // mid-run. The committed count is the only honest lower bound,
                // and using it keeps total_estimated monotone too.
                total_estimated: count,
            }));
    }

    async function send(force, lastError) {
        if (intent.length === 0 || device.length === 0) {
            return false; // cannot satisfy the DTO — stay silent rather than 400
        }
        if (inFlight !== null) {
            if (!force) {
                return false;
            }
            // A terminal flush carries the run's final counts, so dropping it
            // because a throttled report is still outstanding would leave the
            // backend's last view of the run permanently stale. Wait instead.
            await inFlight;
        }
        const at = now();
        if (!force && lastSentAt !== null && at - lastSentAt < minIntervalMs) {
            return false;
        }
        const progress = snapshot();
        if (progress.length === 0) {
            return false;
        }
        const body = { intent_id: intent, deviceId: device, progress };
        const detail = clampString(lastError, PROGRESS_MAX_ERROR);
        if (detail.length > 0) {
            body.lastError = detail;
        }
        lastSentAt = at;
        // The IIFE calls postProgress synchronously (so no extra microtask) while
        // turning a synchronous throw into a rejection; `pending` then never
        // rejects, so an awaiting flush cannot inherit a report's failure.
        const done = (ok) => { inFlight = null; return ok; };
        const pending = (async () => postProgress(body))().then(() => done(true), () => done(false));
        inFlight = pending;
        return pending;
    }

    return {
        // Per-batch hook: absorb the counts and post if the rate budget allows.
        // Deliberately not awaited by the caller, so the crawl is never paced by
        // the reporting channel.
        report(rows, lastError) {
            absorb(rows);
            void send(false, lastError);
        },
        // Terminal hook: post the final counts regardless of the rate budget, so
        // the backend's last view of the run matches what was actually ingested.
        flush(rows, lastError) {
            absorb(rows);
            return send(true, lastError);
        },
    };
}
