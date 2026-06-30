// Pure parsing + entity-building helpers for the TrueCoach extractor.
//
// Every response shape here is locked from REAL captures taken on a live
// trainer account (see /home/user/workspace/truecoach_samples/*.json and
// OPERATOR_QUESTIONS.md → BLOCKERS_RESOLVED_BY_LIVE_SAMPLES). All functions are
// side-effect free so they can be exercised directly against fixtures.
import { makeEntity } from "../_interface.js";
export const PLATFORM = "truecoach";
export function isRecord(value) {
    return typeof value === "object" && value !== null;
}
export function isTcClient(value) {
    return isRecord(value) && typeof value.id === "number" && isRecord(value.links);
}
export function isTcUser(value) {
    // Full-envelope demo users carry email:null, so require id + a name field
    // (email alone is not a reliable discriminator across both shapes).
    return (isRecord(value) &&
        typeof value.id === "number" &&
        (typeof value.email === "string" ||
            value.email === null ||
            typeof value.first_name === "string"));
}
// total_pages lives at the envelope root on the slim /clients list but inside
// `meta` on the full /organizations envelope. Read whichever is present.
function readTotalPages(raw) {
    if (typeof raw.total_pages === "number") {
        return raw.total_pages;
    }
    if (isRecord(raw.meta) && typeof raw.meta.total_pages === "number") {
        return raw.meta.total_pages;
    }
    return undefined;
}
export function parseClientsPage(raw) {
    if (!isRecord(raw)) {
        return { clients: [], users: [] };
    }
    // Both shapes carry `clients[]`; `users[]` is absent on an empty envelope.
    const clients = Array.isArray(raw.clients) ? raw.clients.filter(isTcClient) : [];
    const users = Array.isArray(raw.users) ? raw.users.filter(isTcUser) : [];
    return {
        page: typeof raw.page === "number" ? raw.page : undefined,
        total_pages: readTotalPages(raw),
        clients,
        users,
    };
}
// images[] is denormalized at the envelope level with a parent pointer
// ({ type, id }). Build a lookup of user/client id -> avatar url so entities
// can carry their avatar without a second fetch.
export function indexImagesByParent(raw) {
    const out = new Map();
    if (!isRecord(raw) || !Array.isArray(raw.images)) {
        return out;
    }
    for (const img of raw.images) {
        if (!isRecord(img) || typeof img.image_url !== "string" || !isRecord(img.parent)) {
            continue;
        }
        if (typeof img.parent.id === "number") {
            out.set(img.parent.id, img.image_url);
        }
    }
    return out;
}
// compliance_rate_for_{7,30,90}_days arrive as high-precision decimal STRINGS
// (or numbers) in the full envelope. Parse to float, guarding against NaN.
export function parseComplianceRate(value) {
    if (typeof value === "number") {
        return Number.isNaN(value) ? null : value;
    }
    if (typeof value === "string") {
        const n = parseFloat(value);
        return Number.isNaN(n) ? null : n;
    }
    return null;
}
export function clientLink(client, key) {
    const links = client.links;
    return isRecord(links) && typeof links[key] === "string" ? links[key] : null;
}
// Join a client with its user record, avatar, and parsed compliance into the
// client entity. demo flag + slug + free-text fields are preserved verbatim.
export function buildClientEntity(client, user, extras = {}) {
    const raw = { ...client };
    const compliance = {
        rate_7_day: parseComplianceRate(raw.compliance_rate_for_7_days),
        rate_30_day: parseComplianceRate(raw.compliance_rate_for_30_days),
        rate_90_day: parseComplianceRate(raw.compliance_rate_for_90_days),
    };
    return makeEntity(PLATFORM, client.id, {
        client,
        user,
        avatar_url: extras.avatarUrl ?? null,
        source_slug: typeof raw.slug === "string" ? raw.slug : null,
        demo: isRecord(user) && user.demo === true,
        compliance,
    });
}
function hasNumberId(value) {
    return isRecord(value) && typeof value.id === "number";
}
export function parseWorkoutsEnvelope(raw) {
    if (!isRecord(raw)) {
        return { workouts: [], workout_items: [] };
    }
    const workouts = Array.isArray(raw.workouts) ? raw.workouts.filter(hasNumberId) : [];
    const items = Array.isArray(raw.workout_items)
        ? raw.workout_items.filter(hasNumberId)
        : [];
    const meta = isRecord(raw.meta)
        ? {
            total_pages: typeof raw.meta.total_pages === "number" ? raw.meta.total_pages : undefined,
            total_count: typeof raw.meta.total_count === "number" ? raw.meta.total_count : undefined,
        }
        : undefined;
    return { workouts, workout_items: items, meta };
}
// Join items onto workouts by workout_id and stamp one entity per workout.
export function buildWorkoutEntities(env) {
    const byWorkout = new Map();
    for (const item of env.workout_items) {
        const wid = item.workout_id;
        if (typeof wid !== "number") {
            continue;
        }
        const bucket = byWorkout.get(wid);
        if (bucket) {
            bucket.push(item);
        }
        else {
            byWorkout.set(wid, [item]);
        }
    }
    return env.workouts.map((workout) => {
        const id = workout.id;
        const wid = typeof id === "number" ? id : -1;
        return makeEntity(PLATFORM, wid, { ...workout, items: byWorkout.get(wid) ?? [] });
    });
}
// ----- /clients/{id}/nutrition_plan (SINGLE OBJECT, not an array) -----
// Returns { nutrition_plan: { id, client_id, threshold, <day>_carbs, ... } }
// or { nutrition_plan: null }. Emits one entity per client, or none if null.
export function buildNutritionPlanEntity(raw) {
    if (!isRecord(raw)) {
        return null;
    }
    const plan = raw.nutrition_plan;
    if (!hasNumberId(plan)) {
        return null;
    }
    return makeEntity(PLATFORM, plan.id, { nutrition_plan: plan });
}
// ----- /clients/{id}/weight_trackings -> metric entities -----
// Returns { weight_trackings: [] }. Permissive: emit one metric per record.
export function buildWeightTrackingEntities(raw) {
    if (!isRecord(raw) || !Array.isArray(raw.weight_trackings)) {
        return [];
    }
    return raw.weight_trackings.filter(hasNumberId).map((wt) => makeEntity(PLATFORM, wt.id, { kind: "weight_tracking", ...wt }));
}
// ----- /clients/{id}/assessment_groups -> assessment entities -----
// Returns { assessment_groups: [] }. Permissive; zero entities when empty.
export function buildAssessmentEntities(raw) {
    if (!isRecord(raw) || !Array.isArray(raw.assessment_groups)) {
        return [];
    }
    return raw.assessment_groups.filter(hasNumberId).map((g) => makeEntity(PLATFORM, g.id, { assessment_group: g }));
}
// ----- /clients/{id}/notes -> note entities -----
// Sample empty; permissive parse, zero entities when empty.
export function buildNoteEntities(raw) {
    if (!isRecord(raw) || !Array.isArray(raw.notes)) {
        return [];
    }
    return raw.notes.filter(hasNumberId).map((n) => makeEntity(PLATFORM, n.id, { note: n }));
}
