// Identity bootstrap: /organizations is fetched FIRST so the run learns the
// current trainer + organization id. Those ids gate the exercise filter and are
// stamped onto every emitted entity as provenance. Shape locked from
// truecoach_samples/organizations_with_trainers.json:
//   { organizations:[{ id, owner_id, name, ... }], images:[],
//     trainers:[{ id, user_id, organization_id, is_organization_owner, ... }] }
import { makeEntity } from "../_interface.js";
import { PLATFORM, isRecord } from "./parse.js";
function isWithId(value) {
    return isRecord(value) && typeof value.id === "number";
}
function firstWithId(arr) {
    if (!Array.isArray(arr)) {
        return null;
    }
    for (const item of arr) {
        if (isWithId(item)) {
            return item;
        }
    }
    return null;
}
// /organizations returns TWO shapes: a SLIM self-bootstrap variant with a
// SINGULAR `trainer` object (no users[]/clients[]), and a FULL variant with a
// PLURAL `trainers[]` array plus denormalized users[]/clients[]. Detect which
// by checking whether `trainer` is a non-array object.
export function isSlimOrgEnvelope(raw) {
    return isRecord(raw.trainer) && !Array.isArray(raw.trainer);
}
// Parse the /organizations envelope into the run's identity, handling both the
// slim (singular trainer) and full (trainers[] array) variants. Assumes a
// single self-trainer (the trial / owner case).
export function parseIdentity(raw) {
    if (!isRecord(raw)) {
        return { trainerId: null, orgId: null, trainer: null, organization: null };
    }
    const trainer = isSlimOrgEnvelope(raw)
        ? isWithId(raw.trainer)
            ? raw.trainer
            : null
        : firstWithId(raw.trainers);
    const organization = firstWithId(raw.organizations);
    return {
        trainerId: trainer?.id ?? null,
        orgId: organization?.id ?? null,
        trainer,
        organization,
    };
}
// The trainer entity is emitted FIRST so the backend can attach every later
// entity to a known coach row.
export function buildTrainerEntity(identity) {
    if (!identity.trainer) {
        return null;
    }
    return makeEntity(PLATFORM, identity.trainer.id, { kind: "trainer", ...identity.trainer });
}
export function buildOrganizationEntity(identity) {
    if (!identity.organization) {
        return null;
    }
    return makeEntity(PLATFORM, identity.organization.id, {
        kind: "organization",
        ...identity.organization,
    });
}
// /organizations/{id} detail -> { images:[], organization:{...} }.
export function buildOrganizationDetailEntity(raw) {
    if (!isRecord(raw) || !isRecord(raw.organization) || typeof raw.organization.id !== "number") {
        return null;
    }
    return makeEntity(PLATFORM, raw.organization.id, {
        kind: "organization",
        ...raw.organization,
    });
}
// /tags -> { tags:[], meta:{...} }. Permissive; zero entities while empty.
export function buildTagEntities(raw) {
    if (!isRecord(raw) || !Array.isArray(raw.tags)) {
        return [];
    }
    return raw.tags.filter(isWithId).map((t) => makeEntity(PLATFORM, t.id, { kind: "tag", ...t }));
}
// Provenance stamp applied to every emitted entity's payload so the backend can
// attribute records to the right coach/org across repeated imports.
export function stampProvenance(entities, identity) {
    for (const e of entities) {
        e.payload._tgp_trainer_id = identity.trainerId;
        e.payload._tgp_org_id = identity.orgId;
    }
    return entities;
}
