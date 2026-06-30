// Organization-level library parsers: exercises, warmups, cooldowns, programs,
// skeletons. All endpoints are trainer/org-scoped (NOT per-client) and each
// emits a single logical group per run. Shapes locked from live captures
// (truecoach_samples/{exercises,warmups,cooldowns,programs,skeletons}.json).
import { makeEntity } from "../_interface.js";
import { PLATFORM, isRecord } from "./parse.js";
export const EXERCISE_CHUNK = 500; // stream the large library in chunks
function hasNumberId(value) {
    return isRecord(value) && typeof value.id === "number";
}
// ----- /exercises -> exercise entities (filtered) -----
// The built-in TrueCoach library (trainer_id === null && organization_id ===
// null) is intentionally skipped — importing ~3.8k stock exercises would
// pollute TGP. We keep only exercises the coach actually owns.
export function ownsExercise(ex, trainerId, orgId) {
    const exTrainer = typeof ex.trainer_id === "number" ? ex.trainer_id : null;
    const exOrg = typeof ex.organization_id === "number" ? ex.organization_id : null;
    if (exTrainer === null && exOrg === null) {
        return false; // built-in library
    }
    // When the current ids are unknown (Day-1 fallback) keep all owned exercises.
    if (trainerId === null && orgId === null) {
        return exTrainer !== null || exOrg !== null;
    }
    return ((trainerId !== null && exTrainer === trainerId) ||
        (orgId !== null && exOrg === orgId));
}
export function parseExercises(raw) {
    if (!isRecord(raw) || !Array.isArray(raw.exercises)) {
        return [];
    }
    return raw.exercises.filter(hasNumberId);
}
export function buildExerciseEntities(raw, trainerId, orgId) {
    return parseExercises(raw)
        .filter((ex) => ownsExercise(ex, trainerId, orgId))
        .map((ex) => makeEntity(PLATFORM, ex.id, { kind: "exercise_library_entry", ...ex }));
}
// Split entities into fixed-size chunks so the large library streams as several
// batches rather than one giant ingest call.
export function chunk(items, size = EXERCISE_CHUNK) {
    if (size <= 0) {
        return items.length > 0 ? [items] : [];
    }
    const out = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}
// ----- /warmups + /cooldowns (identical shape, different wrapper key) -----
function buildTemplateEntities(raw, key) {
    if (!isRecord(raw) || !Array.isArray(raw[key])) {
        return [];
    }
    return raw[key]
        .filter(hasNumberId)
        .map((t) => makeEntity(PLATFORM, t.id, { kind: key.replace(/s$/, ""), ...t }));
}
export function buildWarmupEntities(raw) {
    return buildTemplateEntities(raw, "warmups");
}
export function buildCooldownEntities(raw) {
    return buildTemplateEntities(raw, "cooldowns");
}
// ----- /programs -> program entities (workout_ids preserved for server join) -----
export function buildProgramEntities(raw) {
    if (!isRecord(raw) || !Array.isArray(raw.programs)) {
        return [];
    }
    return raw.programs
        .filter(hasNumberId)
        .map((p) => makeEntity(PLATFORM, p.id, { kind: "program", ...p }));
}
// ----- /skeletons -> shape unknown; permissive, zero entities when empty -----
export function buildSkeletonEntities(raw) {
    if (!isRecord(raw) || !Array.isArray(raw.skeletons)) {
        return [];
    }
    return raw.skeletons
        .filter(hasNumberId)
        .map((s) => makeEntity(PLATFORM, s.id, { kind: "skeleton", ...s }));
}
