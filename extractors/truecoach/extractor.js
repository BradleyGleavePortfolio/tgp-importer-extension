// Top-level TrueCoach extractor. Orchestrates the locked entity pipeline
// (identity -> clients -> workouts -> library -> goals; ordering rationale in
// identity.js) and is the class the public barrel (extractors/truecoach.js)
// re-exports.
//
// Design contract:
//   - Dependency-injected side effects: `sendEntities` POSTs a batch to
//     /api/scout/ingest, `broadcastStatus` publishes a status_snapshot. Both
//     are injected so the class is unit-testable with spies.
//   - `now` is an injectable clock (a `() => Date`) so buildDateWindows in
//     net.js is deterministic under test.
//   - `net` is injectable so tests can replay recorded fixtures without touching
//     the live network; it defaults to the real ./net.js module.
//   - R75: zero banned type-assertions. Every narrowing goes through the guards
//     already exported by ./parse.js. R76: this file stays well under 400 LOC,
//     so the per-client walk is inlined here rather than in a helper module.
//
// Endpoint paths below are the ones locked from live captures; see
// extractors/truecoach.js header + truecoach_samples/* (external fixtures).
import {
    parseIdentity,
    buildTrainerEntity,
    buildOrganizationEntity,
    buildTagEntities,
    stampProvenance,
} from "./identity.js";
import {
    parseClientsPage,
    buildClientEntity,
    indexImagesByParent,
    clientLink,
    parseWorkoutsEnvelope,
    buildWorkoutEntities,
    buildNutritionPlanEntity,
    buildWeightTrackingEntities,
    buildAssessmentEntities,
    buildNoteEntities,
} from "./parse.js";
import { parseGoalHtml, looksLikeHtml } from "./goal.js";
import {
    buildExerciseEntities,
    buildWarmupEntities,
    buildCooldownEntities,
    buildProgramEntities,
    buildSkeletonEntities,
    chunk,
    EXERCISE_CHUNK,
} from "./library.js";
import * as defaultNet from "./net.js";

const CLIENTS_PER_PAGE = 25;
const EMPTY_WINDOW_STOP = 2;

// Entity-type keys mirror the popup progress rows; each maps to one progress
// bucket in the snapshot.
const ENTITY_TYPES = [
    "identity",
    "clients",
    "workouts",
    "library",
    "goals",
];

export class TrueCoachExtractor {
    /**
     * @param {object} deps
     * @param {(entityType: string, entities: object[]) => Promise<void>} [deps.sendEntities]
     * @param {(snapshot: object) => void} [deps.broadcastStatus]
     * @param {() => Date} [deps.now] injectable clock (defaults to Date.now).
     * @param {typeof import("./net.js")} [deps.net] injectable networking module.
     */
    constructor({ sendEntities, broadcastStatus, now, net } = {}) {
        if (typeof sendEntities !== "function") {
            throw new Error("TrueCoachExtractor: sendEntities is required");
        }
        if (typeof broadcastStatus !== "function") {
            throw new Error("TrueCoachExtractor: broadcastStatus is required");
        }
        this.sendEntities = sendEntities;
        this.broadcastStatus = broadcastStatus;
        this.now = typeof now === "function" ? now : () => new Date();
        this.net = net ?? defaultNet;
        // Progress is keyed by entity type; sent/total accumulate across the run.
        this.progress = new Map(ENTITY_TYPES.map((t) => [t, { sent: 0, total: 0 }]));
        this.identity = { trainerId: null, orgId: null, trainer: null, organization: null };
    }

    // ---- progress helpers ---------------------------------------------------

    addTotal(entityType, n) {
        const row = this.progress.get(entityType);
        if (row) {
            row.total += n;
        }
    }

    snapshot() {
        const progress = [];
        for (const [entityType, row] of this.progress) {
            progress.push({ entityType, sent: row.sent, total: row.total });
        }
        return { kind: "status_snapshot", progress };
    }

    // Commit one batch: stamp provenance, send, tick progress, broadcast.
    async commit(entityType, entities) {
        if (entities.length === 0) {
            this.broadcastStatus(this.snapshot());
            return;
        }
        stampProvenance(entities, this.identity);
        await this.sendEntities(entityType, entities);
        const row = this.progress.get(entityType);
        if (row) {
            row.sent += entities.length;
            if (row.total < row.sent) {
                row.total = row.sent;
            }
        }
        this.broadcastStatus(this.snapshot());
    }

    // ---- pipeline stages ----------------------------------------------------

    async runIdentity(ctx) {
        const raw = await this.net.getJson("/organizations", ctx.token, ctx.signal);
        this.identity = parseIdentity(raw);
        const entities = [];
        const trainer = buildTrainerEntity(this.identity);
        if (trainer) {
            entities.push(trainer);
        }
        const org = buildOrganizationEntity(this.identity);
        if (org) {
            entities.push(org);
        }
        this.addTotal("identity", entities.length);
        await this.commit("identity", entities);
        // Tags are org-scoped identity metadata; permissive (often empty).
        const tagsRaw = await this.net.getJson("/tags", ctx.token, ctx.signal);
        const tags = buildTagEntities(tagsRaw);
        this.addTotal("identity", tags.length);
        await this.commit("identity", tags);
    }

    async runClients(ctx) {
        const collected = [];
        let page = 1;
        let totalPages;
        do {
            const path = `/clients?page=${page}&per_page=${CLIENTS_PER_PAGE}`;
            const raw = await this.net.getJson(path, ctx.token, ctx.signal);
            const parsed = parseClientsPage(raw);
            const avatars = indexImagesByParent(raw);
            const usersById = new Map();
            for (const u of parsed.users) {
                usersById.set(u.id, u);
            }
            this.addTotal("clients", parsed.clients.length);
            for (const client of parsed.clients) {
                const user = usersById.get(client.user_id) ?? null;
                const entity = buildClientEntity(client, user, {
                    avatarUrl: avatars.get(client.id) ?? null,
                });
                await this.commit("clients", [entity]);
                await this.walkClient(client, ctx);
                collected.push(client);
            }
            totalPages = typeof parsed.total_pages === "number" ? parsed.total_pages : 1;
            page += 1;
        } while (page <= totalPages);
        return collected;
    }

    // Per-client sub-entities: workouts (date-window walk) + nutrition, weight,
    // assessments, notes, and the HTMX goal fragment. All permissive.
    async walkClient(client, ctx) {
        const clientId = client.id;
        // Workouts: walk backwards in date windows; stop after a run of empties.
        const windows = this.net.buildDateWindows(this.now());
        let empties = 0;
        for (const w of windows) {
            if (empties >= EMPTY_WINDOW_STOP) {
                break;
            }
            const raw = await this.net.getJson(
                this.net.workoutsPath(clientId, w), ctx.token, ctx.signal);
            const env = parseWorkoutsEnvelope(raw);
            const entities = buildWorkoutEntities(env);
            if (entities.length === 0) {
                empties += 1;
            }
            else {
                empties = 0;
                this.addTotal("workouts", entities.length);
                await this.commit("workouts", entities);
            }
        }
        // Single-shot per-client endpoints, permissive parse.
        const single = [
            { path: `/clients/${clientId}/nutrition_plan`,
              build: (r) => { const e = buildNutritionPlanEntity(r); return e ? [e] : []; } },
            { path: `/clients/${clientId}/weight_trackings`, build: buildWeightTrackingEntities },
            { path: `/clients/${clientId}/assessment_groups`, build: buildAssessmentEntities },
            { path: `/clients/${clientId}/notes`, build: buildNoteEntities },
        ];
        for (const { path, build } of single) {
            const raw = await this.net.getJson(path, ctx.token, ctx.signal);
            const entities = build(raw);
            this.addTotal("workouts", entities.length);
            await this.commit("workouts", entities);
        }
        // Goal endpoint returns an HTMX HTML fragment (or JSON); branch on type.
        const goalLink = clientLink(client, "goal");
        const goalPath = goalLink ?? `/clients/${clientId}/goal`;
        const { contentType, body } = await this.net.getBody(goalPath, ctx.token, ctx.signal);
        if (looksLikeHtml(contentType, body)) {
            const goal = parseGoalHtml(body, clientId);
            if (goal) {
                this.addTotal("goals", 1);
                await this.commit("goals", [goal]);
            }
        }
    }

    async runLibrary(ctx) {
        const { trainerId, orgId } = this.identity;
        // Exercises: owned-only filter, streamed in EXERCISE_CHUNK batches.
        const exRaw = await this.net.getJson("/exercises", ctx.token, ctx.signal);
        const exercises = buildExerciseEntities(exRaw, trainerId, orgId);
        this.addTotal("library", exercises.length);
        for (const batch of chunk(exercises, EXERCISE_CHUNK)) {
            await this.commit("library", batch);
        }
        // Templates + programs + skeletons: one fetch each, permissive parse.
        const simple = [
            { path: "/warmups", build: buildWarmupEntities },
            { path: "/cooldowns", build: buildCooldownEntities },
            { path: "/programs", build: buildProgramEntities },
            { path: "/skeletons", build: buildSkeletonEntities },
        ];
        for (const { path, build } of simple) {
            const raw = await this.net.getJson(path, ctx.token, ctx.signal);
            const entities = build(raw);
            this.addTotal("library", entities.length);
            await this.commit("library", entities);
        }
    }

    /**
     * Orchestrate the full run. Context (source platform bearer token + abort
     * signal) is passed in per-run so the class holds no live credential.
     * @param {{ token: string, signal: AbortSignal }} ctx
     */
    async run(ctx) {
        const runCtx = {
            token: ctx.token,
            signal: ctx.signal ?? new AbortController().signal,
        };
        this.broadcastStatus(this.snapshot());
        await this.runIdentity(runCtx);
        await this.runClients(runCtx);
        await this.runLibrary(runCtx);
        this.broadcastStatus(this.snapshot());
        return this.snapshot();
    }
}
