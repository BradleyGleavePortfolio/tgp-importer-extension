// Data-only TrueCoach PlatformBlueprint — a VERIFICATION adapter, not the
// product core. It contains ZERO executable extraction logic: only endpoint
// roles, id fields, a pagination descriptor, and one fan-out edge expressed as
// data, so the site-agnostic replay engine (shared/replay/engine.js) can drive
// TrueCoach under the coach's own session. Endpoint shapes are the ones locked
// from live captures (see extractors/truecoach.js header + truecoach_samples/*).
//
// This is deliberately a SUBSET of the hand-mapped TrueCoachExtractor: it proves
// the generic engine performs autonomous multi-page traversal (list -> paginate
// -> fan-out over collected ids) against a real platform. The date-window
// workout walk the extractor does cannot be expressed as generic page/cursor
// pagination, so it stays in the extractor; the blueprint models the parts the
// generic model covers. The whole file is retired the moment blueprint
// inference (PR-C2) lands and infers this shape from capture instead.
//
// apiBase is https://app.truecoach.co/proxy/api; its origin
// (https://app.truecoach.co) must appear in the caller-injected allowedOrigins
// (the observed tab origin), enforced by normalizeBlueprint before any fetch.
import { TRUECOACH_API_BASE } from "../../shared/protocol.js";

// ~2 requests/second — mirrors the extractor's RATE_LIMIT_MS so the generic
// crawl paces identically to the verified hand-mapped walk.
const RATE_LIMIT_MS = 500;
const CLIENTS_PER_PAGE = 25;

export function truecoachBlueprint() {
    return {
        platform: "truecoach",
        apiBase: TRUECOACH_API_BASE,
        rateLimitMs: RATE_LIMIT_MS,
        steps: [
            {
                // Client roster, page-paginated. Collect each client id so the
                // fan-out step below can walk per-client sub-resources.
                id: "clients",
                entityType: "clients",
                template: `/clients?per_page=${CLIENTS_PER_PAGE}`,
                itemsPath: ["clients"],
                idField: "id",
                collectAs: "clientIds",
                pagination: { style: "page", param: "page", start: 1 },
            },
            {
                // Per-client notes: one request per collected client id. A static
                // single-page detail endpoint (no pagination); the engine's
                // per-context visited set fetches it once for EACH parent id.
                id: "notes",
                entityType: "notes",
                template: "/clients/:id/notes",
                forEach: "clientIds",
                itemsPath: ["notes"],
                idField: "id",
            },
        ],
    };
}
