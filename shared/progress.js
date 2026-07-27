// TGP Importer — bounded, monotone progress reporting for POST /api/scout/progress.
//
// The engine's onProgress fires once per emitted batch, which on a large crawl is
// far more often than the backend's 240-req/min throttle allows and carries a
// per-step view that can legitimately go backwards between contexts. This module
// is the adapter between the two, and it enforces both halves of the contract the
// backend DTO expects:
//
//   BOUNDED  — at most one POST per minIntervalMs and never two in flight, at most
//              PROGRESS_MAX_ENTRIES entries, and every string clamped to the
//              backend's MaxLength. An unbounded or oversized report would be
//              throttled (429) or rejected (400) and lose the whole series.
//   MONOTONE — count_committed is a per-entity high-water mark, so a report can
//              never claim fewer records than an earlier one already did. A
//              backwards count reads to the coach as data being lost.
//
// Reporting is strictly advisory: a failed progress POST must never fail an
// import, so nothing here throws or rejects. No chrome.* calls and no token
// handling — the POST is injected, so this is a pure, testable unit.

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
        // Invoked synchronously (no extra microtask), then made never-rejecting so
        // an awaiting flush cannot inherit a report's failure.
        let posted;
        try {
            posted = Promise.resolve(postProgress(body));
        }
        catch {
            posted = Promise.reject(new Error("progress post threw"));
        }
        const clear = () => {
            if (inFlight === pending) {
                inFlight = null;
            }
        };
        const pending = posted.then(() => { clear(); return true; }, () => { clear(); return false; });
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
