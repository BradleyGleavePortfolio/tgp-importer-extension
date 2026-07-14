import { describe, it, expect } from "vitest";
import { STATE, EVENT, transition, isTerminal } from "../shared/replay/state.js";

// The import-flow state machine is a pure transition table: every legal edge is
// pinned here, and every (state,event) NOT in the table must return null so an
// out-of-order event can never silently corrupt the observable surface.

describe("state machine — happy path", () => {
    it("drives the flagship direct path READY -> IMPORTING -> COMPLETE", () => {
        let s = STATE.READY;
        s = transition(s, EVENT.START);
        expect(s).toBe(STATE.IMPORTING);
        s = transition(s, EVENT.FINISH);
        expect(s).toBe(STATE.COMPLETE);
    });

    it("drives the learn path READY -> LEARNING -> CONFIRMING -> IMPORTING", () => {
        let s = STATE.READY;
        s = transition(s, EVENT.LEARN);
        expect(s).toBe(STATE.LEARNING);
        s = transition(s, EVENT.BLUEPRINT_READY);
        expect(s).toBe(STATE.CONFIRMING);
        s = transition(s, EVENT.CONFIRM);
        expect(s).toBe(STATE.IMPORTING);
    });
});

describe("state machine — cancel + fail edges", () => {
    it("allows cancel from learning, confirming, and importing", () => {
        expect(transition(STATE.LEARNING, EVENT.CANCEL)).toBe(STATE.CANCELLED);
        expect(transition(STATE.CONFIRMING, EVENT.CANCEL)).toBe(STATE.CANCELLED);
        expect(transition(STATE.IMPORTING, EVENT.CANCEL)).toBe(STATE.CANCELLED);
    });

    it("allows fail from learning and importing", () => {
        expect(transition(STATE.LEARNING, EVENT.FAIL)).toBe(STATE.FAILED);
        expect(transition(STATE.IMPORTING, EVENT.FAIL)).toBe(STATE.FAILED);
    });

    it("lets confirming re-learn (re-infer a blueprint)", () => {
        expect(transition(STATE.CONFIRMING, EVENT.LEARN)).toBe(STATE.LEARNING);
    });
});

describe("state machine — illegal transitions return null", () => {
    it("rejects events that are not legal from the current state", () => {
        expect(transition(STATE.READY, EVENT.FINISH)).toBeNull();
        expect(transition(STATE.READY, EVENT.CANCEL)).toBeNull();
        expect(transition(STATE.COMPLETE, EVENT.START)).toBeNull();
        expect(transition(STATE.IMPORTING, EVENT.START)).toBeNull();
        expect(transition(STATE.FAILED, EVENT.FINISH)).toBeNull();
    });

    it("returns null for an unknown state or unknown event", () => {
        expect(transition("bogus", EVENT.START)).toBeNull();
        expect(transition(STATE.READY, "bogus")).toBeNull();
    });

    // Inherited Object.prototype keys must NOT resolve to a truthy prototype
    // member — the lookup uses own-property checks so the documented "anything not
    // in the table returns null" invariant holds even for prototype-pollution keys.
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
        it(`returns null when the event is the inherited key "${key}"`, () => {
            expect(transition(STATE.READY, key)).toBeNull();
        });
        it(`returns null when the state is the inherited key "${key}"`, () => {
            expect(transition(key, EVENT.START)).toBeNull();
        });
    }

    it("returns null for a non-string state or event", () => {
        expect(transition(null, EVENT.START)).toBeNull();
        expect(transition(STATE.READY, null)).toBeNull();
        expect(transition(undefined, undefined)).toBeNull();
        expect(transition(42, {})).toBeNull();
    });
});

describe("state machine — terminal re-arm", () => {
    it("only RESET re-arms a terminal state back to READY", () => {
        expect(transition(STATE.COMPLETE, EVENT.RESET)).toBe(STATE.READY);
        expect(transition(STATE.FAILED, EVENT.RESET)).toBe(STATE.READY);
        expect(transition(STATE.CANCELLED, EVENT.RESET)).toBe(STATE.READY);
    });

    it("classifies terminal vs non-terminal states", () => {
        expect(isTerminal(STATE.COMPLETE)).toBe(true);
        expect(isTerminal(STATE.FAILED)).toBe(true);
        expect(isTerminal(STATE.CANCELLED)).toBe(true);
        expect(isTerminal(STATE.READY)).toBe(false);
        expect(isTerminal(STATE.IMPORTING)).toBe(false);
        expect(isTerminal(STATE.LEARNING)).toBe(false);
    });
});

describe("state machine — purity", () => {
    it("is a pure function: repeated calls with the same input return the same next state", () => {
        expect(transition(STATE.READY, EVENT.START)).toBe(transition(STATE.READY, EVENT.START));
        expect(transition(STATE.CONFIRMING, EVENT.CONFIRM)).toBe(STATE.IMPORTING);
        expect(transition(STATE.CONFIRMING, EVENT.CONFIRM)).toBe(STATE.IMPORTING);
    });

    it("never mutates the STATE or EVENT constant objects (frozen)", () => {
        expect(Object.isFrozen(STATE)).toBe(true);
        expect(Object.isFrozen(EVENT)).toBe(true);
    });
});

describe("state machine — no terminal-to-terminal or skip edges", () => {
    it("cannot go directly from importing to a terminal via a learn/confirm event", () => {
        expect(transition(STATE.IMPORTING, EVENT.LEARN)).toBeNull();
        expect(transition(STATE.IMPORTING, EVENT.CONFIRM)).toBeNull();
        expect(transition(STATE.IMPORTING, EVENT.BLUEPRINT_READY)).toBeNull();
    });

    it("cannot RESET a non-terminal state", () => {
        expect(transition(STATE.READY, EVENT.RESET)).toBeNull();
        expect(transition(STATE.IMPORTING, EVENT.RESET)).toBeNull();
        expect(transition(STATE.LEARNING, EVENT.RESET)).toBeNull();
    });

    it("only reaches CONFIRMING via BLUEPRINT_READY from LEARNING", () => {
        expect(transition(STATE.READY, EVENT.BLUEPRINT_READY)).toBeNull();
        expect(transition(STATE.LEARNING, EVENT.BLUEPRINT_READY)).toBe(STATE.CONFIRMING);
    });
});

// The full transition table pinned exhaustively: this is the authoritative spec
// of the machine. LEGAL lists every edge that MUST exist and its target; every
// (state,event) pair NOT in LEGAL must return null. Together they prove the table
// has no missing edge and no extra edge — an out-of-order event can never move the
// surface somewhere the product did not intend.

const LEGAL = [
    [STATE.READY, EVENT.LEARN, STATE.LEARNING],
    [STATE.READY, EVENT.START, STATE.IMPORTING],
    [STATE.LEARNING, EVENT.BLUEPRINT_READY, STATE.CONFIRMING],
    [STATE.LEARNING, EVENT.CANCEL, STATE.CANCELLED],
    [STATE.LEARNING, EVENT.FAIL, STATE.FAILED],
    [STATE.CONFIRMING, EVENT.CONFIRM, STATE.IMPORTING],
    [STATE.CONFIRMING, EVENT.START, STATE.IMPORTING],
    [STATE.CONFIRMING, EVENT.CANCEL, STATE.CANCELLED],
    [STATE.CONFIRMING, EVENT.LEARN, STATE.LEARNING],
    [STATE.IMPORTING, EVENT.FINISH, STATE.COMPLETE],
    [STATE.IMPORTING, EVENT.FAIL, STATE.FAILED],
    [STATE.IMPORTING, EVENT.CANCEL, STATE.CANCELLED],
    [STATE.COMPLETE, EVENT.RESET, STATE.READY],
    [STATE.FAILED, EVENT.RESET, STATE.READY],
    [STATE.CANCELLED, EVENT.RESET, STATE.READY],
];

describe("state machine — exhaustive transition matrix", () => {
    it("every LEGAL edge yields its documented target", () => {
        for (const [from, event, to] of LEGAL) {
            expect(transition(from, event)).toBe(to);
        }
    });

    it("every (state,event) pair NOT in LEGAL returns null", () => {
        const legalSet = new Set(LEGAL.map(([s, e]) => `${s} ${e}`));
        const allStates = Object.values(STATE);
        const allEvents = Object.values(EVENT);
        let checkedIllegal = 0;
        for (const s of allStates) {
            for (const e of allEvents) {
                if (legalSet.has(`${s} ${e}`)) {
                    continue;
                }
                expect(transition(s, e)).toBeNull();
                checkedIllegal += 1;
            }
        }
        // 7 states x 8 events = 56 pairs; 15 legal -> 41 illegal must be null.
        expect(checkedIllegal).toBe(allStates.length * allEvents.length - LEGAL.length);
    });

    it("no legal edge lands on an undefined/unknown state", () => {
        const known = new Set(Object.values(STATE));
        for (const [, , to] of LEGAL) {
            expect(known.has(to)).toBe(true);
        }
    });

    it("every terminal state is reachable and re-arms only via RESET", () => {
        for (const term of [STATE.COMPLETE, STATE.FAILED, STATE.CANCELLED]) {
            expect(isTerminal(term)).toBe(true);
            expect(transition(term, EVENT.RESET)).toBe(STATE.READY);
            for (const e of Object.values(EVENT)) {
                if (e === EVENT.RESET) {
                    continue;
                }
                expect(transition(term, e)).toBeNull();
            }
        }
    });

    it("no non-terminal state accepts RESET", () => {
        for (const s of [STATE.READY, STATE.LEARNING, STATE.CONFIRMING, STATE.IMPORTING]) {
            expect(isTerminal(s)).toBe(false);
            expect(transition(s, EVENT.RESET)).toBeNull();
        }
    });

    it("IMPORTING is reachable from both the direct and the learn path", () => {
        expect(transition(STATE.READY, EVENT.START)).toBe(STATE.IMPORTING);
        expect(transition(STATE.CONFIRMING, EVENT.CONFIRM)).toBe(STATE.IMPORTING);
        expect(transition(STATE.CONFIRMING, EVENT.START)).toBe(STATE.IMPORTING);
    });

    it("every legal edge is idempotent across repeated calls", () => {
        for (const [from, event, to] of LEGAL) {
            const first = transition(from, event);
            const second = transition(from, event);
            expect(first).toBe(to);
            expect(second).toBe(to);
        }
    });

    it("no legal edge is a self-loop (every transition changes state)", () => {
        for (const [from, event, to] of LEGAL) {
            expect(to).not.toBe(from);
            // silence unused-var lint on event while keeping the tuple shape explicit
            expect(typeof event).toBe("string");
        }
    });
});

describe("state machine — constant surface", () => {
    it("exposes the seven documented states", () => {
        expect(Object.values(STATE).sort()).toEqual(
            ["cancelled", "complete", "confirming", "failed", "importing", "learning", "ready"],
        );
    });

    it("exposes the eight documented events", () => {
        expect(Object.values(EVENT).sort()).toEqual(
            ["blueprint_ready", "cancel", "confirm", "fail", "finish", "learn", "reset", "start"],
        );
    });

    it("has distinct string values for every state and every event", () => {
        const states = Object.values(STATE);
        const events = Object.values(EVENT);
        expect(new Set(states).size).toBe(states.length);
        expect(new Set(events).size).toBe(events.length);
        for (const v of [...states, ...events]) {
            expect(typeof v).toBe("string");
            expect(v.length).toBeGreaterThan(0);
        }
    });

    it("keeps state and event namespaces disjoint", () => {
        const states = new Set(Object.values(STATE));
        for (const e of Object.values(EVENT)) {
            expect(states.has(e)).toBe(false);
        }
    });
});

describe("state machine — reachability closure", () => {
    it("can walk READY -> LEARNING -> CONFIRMING -> IMPORTING -> COMPLETE -> READY", () => {
        let s = STATE.READY;
        s = transition(s, EVENT.LEARN);
        s = transition(s, EVENT.BLUEPRINT_READY);
        s = transition(s, EVENT.CONFIRM);
        s = transition(s, EVENT.FINISH);
        expect(s).toBe(STATE.COMPLETE);
        s = transition(s, EVENT.RESET);
        expect(s).toBe(STATE.READY);
    });

    it("can recover a failed run back to READY and start again", () => {
        let s = transition(STATE.IMPORTING, EVENT.FAIL);
        expect(s).toBe(STATE.FAILED);
        s = transition(s, EVENT.RESET);
        expect(s).toBe(STATE.READY);
        expect(transition(s, EVENT.START)).toBe(STATE.IMPORTING);
    });

    it("reaches every terminal state from IMPORTING via its own event", () => {
        expect(transition(STATE.IMPORTING, EVENT.FINISH)).toBe(STATE.COMPLETE);
        expect(transition(STATE.IMPORTING, EVENT.FAIL)).toBe(STATE.FAILED);
        expect(transition(STATE.IMPORTING, EVENT.CANCEL)).toBe(STATE.CANCELLED);
    });
});
