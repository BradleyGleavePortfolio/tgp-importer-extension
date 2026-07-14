// Data-only TrueCoach PlatformBlueprint — a VERIFICATION adapter with ZERO
// executable extraction logic (only endpoint roles, id fields, a pagination
// descriptor, and one fan-out edge as data) so the site-agnostic replay engine
// can drive TrueCoach under the coach's own session. It is a deliberate SUBSET of
// the hand-mapped TrueCoachExtractor, proving the generic engine does autonomous
// multi-page traversal (list -> paginate -> fan-out over ids) against a real
// platform. apiBase origin (https://app.truecoach.co) must appear in the injected
// allowedOrigins, enforced by normalizeBlueprint before any fetch.
import { TRUECOACH_API_BASE } from "../../shared/protocol.js";

// ~2 req/s — mirrors the extractor's RATE_LIMIT_MS so the generic crawl paces
// identically to the verified hand-mapped walk.
const RATE_LIMIT_MS = 500;
const CLIENTS_PER_PAGE = 25;

export function truecoachBlueprint() {
    return {
        platform: "truecoach",
        apiBase: TRUECOACH_API_BASE,
        rateLimitMs: RATE_LIMIT_MS,
        steps: [
            {
                // Client roster, page-paginated; collect ids for the fan-out below.
                id: "clients",
                entityType: "clients",
                template: `/clients?per_page=${CLIENTS_PER_PAGE}`,
                itemsPath: ["clients"],
                idField: "id",
                collectAs: "clientIds",
                pagination: { style: "page", param: "page", start: 1 },
            },
            {
                // Per-client notes: one single-page request per collected id.
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
