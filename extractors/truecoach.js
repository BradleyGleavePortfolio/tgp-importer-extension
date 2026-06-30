// Public surface of the TrueCoach extractor. The implementation is split across
// extractors/truecoach/* (per R76, each module ≤400 LOC) and re-exported here so
// the host, tests, and downstream importers keep a single stable entry point.
//
// Endpoint shapes are locked from live captures (truecoach_samples/*); see
// OPERATOR_QUESTIONS.md → BLOCKERS_RESOLVED_BY_LIVE_SAMPLES.
export { TrueCoachExtractor } from "./truecoach/extractor.js";
export { PLATFORM, isRecord, isTcClient, isTcUser, parseClientsPage, buildClientEntity, indexImagesByParent, parseComplianceRate, clientLink, parseWorkoutsEnvelope, buildWorkoutEntities, buildNutritionPlanEntity, buildWeightTrackingEntities, buildAssessmentEntities, buildNoteEntities, } from "./truecoach/parse.js";
export { looksLikeHtml, parseGoalDocument, parseGoalHtml, isJsonGoal, GOAL_FIELDS, } from "./truecoach/goal.js";
export { ownsExercise, parseExercises, buildExerciseEntities, chunk, buildWarmupEntities, buildCooldownEntities, buildProgramEntities, buildSkeletonEntities, EXERCISE_CHUNK, } from "./truecoach/library.js";
export { parseIdentity, isSlimOrgEnvelope, buildTrainerEntity, buildOrganizationEntity, buildOrganizationDetailEntity, buildTagEntities, stampProvenance, } from "./truecoach/identity.js";
export { buildDateWindows, workoutsPath, WINDOW_DAYS, EMPTY_WINDOW_STOP, MAX_LOOKBACK_DAYS, } from "./truecoach/net.js";
