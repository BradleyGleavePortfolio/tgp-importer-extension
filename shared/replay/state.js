// Explicit bounded state machine for the site-agnostic import flow
// (docs/AUTO_DISCOVERY.md §3 Learn -> Confirm -> Import; docs/DESIGN.md §2).
//
// The machine is a pure transition table: `transition(state, event)` returns the
// next state or null when the event is illegal from the current state. It holds
// NO data and performs NO IO, so orchestration (background.js) and the popup can
// share one source of truth for legal transitions without a browser.
//
// States (the surfaces a coach can observe):
//   ready       — session present, nothing running; Start Import is offered.
//   learning    — passive capture running (Layer 1) so a blueprint can be inferred.
//   confirming  — a blueprint is inferred and shown for coach confirmation.
//   importing   — the replay engine is autonomously walking pages + emitting.
//   complete    — terminal success; ingest/complete fired.
//   failed      — terminal failure (auth loss, unknown platform, hard error).
//   cancelled   — terminal: the coach aborted (or auth was lost mid-crawl).
//
// v0.3 note: LEARNING/CONFIRMING are driven only once blueprint inference lands
// (PR-C2, see docs/DECISION_V03_AUTONOMOUS_CRAWL.md). Today the flagship path
// resolves a blueprint directly and goes READY -> IMPORTING -> terminal. Both
// paths are legal here so the machine does not change when inference merges.

export const STATE = Object.freeze({
    READY: "ready",
    LEARNING: "learning",
    CONFIRMING: "confirming",
    IMPORTING: "importing",
    COMPLETE: "complete",
    FAILED: "failed",
    CANCELLED: "cancelled",
});

export const EVENT = Object.freeze({
    LEARN: "learn",
    BLUEPRINT_READY: "blueprint_ready",
    CONFIRM: "confirm",
    START: "start",
    FINISH: "finish",
    FAIL: "fail",
    CANCEL: "cancel",
    RESET: "reset",
});

// Legal transitions. Any (state,event) not listed is illegal and returns null,
// so an out-of-order event can never silently corrupt the surface.
const TABLE = {
    [STATE.READY]: {
        [EVENT.LEARN]: STATE.LEARNING,
        [EVENT.START]: STATE.IMPORTING,
    },
    [STATE.LEARNING]: {
        [EVENT.BLUEPRINT_READY]: STATE.CONFIRMING,
        [EVENT.CANCEL]: STATE.CANCELLED,
        [EVENT.FAIL]: STATE.FAILED,
    },
    [STATE.CONFIRMING]: {
        [EVENT.CONFIRM]: STATE.IMPORTING,
        [EVENT.START]: STATE.IMPORTING,
        [EVENT.CANCEL]: STATE.CANCELLED,
        [EVENT.LEARN]: STATE.LEARNING,
    },
    [STATE.IMPORTING]: {
        [EVENT.FINISH]: STATE.COMPLETE,
        [EVENT.FAIL]: STATE.FAILED,
        [EVENT.CANCEL]: STATE.CANCELLED,
    },
    // Terminal states re-arm only via an explicit RESET back to READY.
    [STATE.COMPLETE]: { [EVENT.RESET]: STATE.READY },
    [STATE.FAILED]: { [EVENT.RESET]: STATE.READY },
    [STATE.CANCELLED]: { [EVENT.RESET]: STATE.READY },
};

const TERMINAL = new Set([STATE.COMPLETE, STATE.FAILED, STATE.CANCELLED]);

export function isTerminal(state) {
    return TERMINAL.has(state);
}

// Pure transition. Returns the next state, or null if the event is not legal
// from `state` (caller decides whether that is a no-op or a programmer error).
export function transition(state, event) {
    const row = TABLE[state];
    if (row === undefined) {
        return null;
    }
    const next = row[event];
    return next === undefined ? null : next;
}
