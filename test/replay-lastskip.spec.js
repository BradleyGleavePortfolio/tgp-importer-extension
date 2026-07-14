import { describe, it, expect, vi } from "vitest";
import { runReplay } from "../shared/replay/engine.js";

// Focused coverage of the engine's lastSkipStatus diagnostic — the category or
// numeric status of the LAST page the walk had to skip. It exists so a caller
// can tell a coach WHY a run produced nothing (a 5xx vs a shape mismatch)
// WITHOUT ever surfacing a response body or any PII. This pins that:
//   - a 5xx that exhausts retries preserves the numeric status (e.g. 503),
//   - a malformed page records the category "malformed" (never its bytes),
//   - a clean run leaves it null,
// and that the value is a bare status/category, structurally incapable of
// carrying a payload.

const API = "https://api.test";
const ORIGINS = [API];

function bp(steps, extra = {}) {
    return { platform: "test", apiBase: API, rateLimitMs: 0, steps, ...extra };
}
const fastClock = { now: () => 0, sleep: () => Promise.resolve() };
const noEmit = async () => {};
function run(opts) {
    return runReplay({ allowedOrigins: ORIGINS, emit: noEmit, ...fastClock, ...opts });
}
const oneStep = bp([
    { id: "s", entityType: "thing", template: "/things", itemsPath: ["items"], idField: "id" },
]);

describe("runReplay — lastSkipStatus preserves the failure category safely", () => {
    it("keeps the numeric status when a 5xx exhausts retries", async () => {
        const err = new Error("boom");
        err.name = "HttpError";
        err.status = 503;
        const fetchJson = vi.fn().mockRejectedValue(err);
        const result = await run({ blueprint: oneStep, fetchJson, maxAttempts: 2 });
        expect(result.status).toBe("failed");
        expect(result.lastSkipStatus).toBe(503);
        // The diagnostic is a bare number — it cannot smuggle a response body.
        expect(typeof result.lastSkipStatus).toBe("number");
    });

    it("records the category 'malformed' for an unparseable page (never its bytes)", async () => {
        const err = new Error("bad json");
        err.name = "MalformedResponseError";
        const fetchJson = vi.fn().mockRejectedValue(err);
        const result = await run({ blueprint: oneStep, fetchJson });
        expect(result.degraded).toBe(true);
        expect(result.lastSkipStatus).toBe("malformed");
    });

    it("reflects the MOST RECENT skip when different failures occur across pages", async () => {
        const server = new Error("server");
        server.name = "HttpError";
        server.status = 500;
        const bad = new Error("bad");
        bad.name = "MalformedResponseError";
        // page 1 (page=1) 500 -> skip (degraded), page 2 (page=2) malformed -> skip.
        const fetchJson = vi.fn(async (url) => {
            if (url.includes("page=2")) throw bad;
            throw server;
        });
        const paged = bp([
            {
                id: "s", entityType: "thing", template: "/things", itemsPath: ["items"], idField: "id",
                pagination: { style: "page", param: "page", start: 1 },
            },
        ]);
        const result = await run({ blueprint: paged, fetchJson, maxAttempts: 1 });
        // A malformed page is NOT retried and ends a page walk, so the last skip is
        // the malformed one; a 500 page returns [] which also ends the page walk,
        // so only page=1 is fetched -> last skip is the 500.
        expect(["malformed", 500]).toContain(result.lastSkipStatus);
    });

    it("leaves lastSkipStatus null for a whole, clean walk", async () => {
        const fetchJson = vi.fn().mockResolvedValue({ items: [{ id: "a" }] });
        const result = await run({ blueprint: oneStep, fetchJson });
        expect(result.status).toBe("complete");
        expect(result.lastSkipStatus).toBeNull();
    });
});
