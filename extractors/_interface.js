// =============================================================================
// LOCKED EXTRACTOR INTERFACE — M-IMPORTER-EXTENSION v0
// =============================================================================
//
// This file is the CONTRACT every per-platform extractor implements. It is
// locked: Chef #2–#6 (CoachRx, MyPTHub, Trainerize, PT Distinction, FitSW)
// build against this exact shape without ambiguity. Change it only via an
// operator ruling, because changing it breaks every downstream extractor.
//
// Design constraints honoured here:
//   - Zero banned type-assertions anywhere (R75): no escape-hatch casts, no
//     suppression directives. Every narrowing uses a real type guard.
//   - Entity envelope is EXACTLY what makeEntity() returns — camelCase, with
//     provenance at the entity top level:
//         { sourceId, sourcePlatform, capturedAt, payload }
//     The background worker forwards batches as
//     { intent_id, entity_type, entities:[<makeEntity() output verbatim>] }
//     (outer envelope snake_case per the backend ScoutIngestDto; entities are
//     never reshaped). This shape is the authoritative envelope per
//     R80-CLARIFY-1 (2026-07-07). Do not add per-comment aliases.
//   - Every entity is self-describing (sourcePlatform + capturedAt) so the
//     backend can attribute provenance without out-of-band state.
//
// See per-platform verification reports under
// /home/user/workspace/platform_verification/*.md for the endpoint shapes each
// implementation relies on.
// =============================================================================
/**
 * Helper for implementations: stamp a raw platform object into an `Entity`.
 * Keeps `capturedAt` consistent and avoids per-extractor boilerplate.
 */
export function makeEntity(platform, sourceId, payload) {
    return {
        sourceId: String(sourceId),
        sourcePlatform: platform,
        payload,
        capturedAt: new Date().toISOString(),
    };
}
