import { describe, it, expect, vi } from "vitest";
import { runReplay } from "../shared/replay/engine.js";

// `result.counts` — the per-entity tally the terminal settlement reports as
// `final_counts`.
//
// The settlement used to send `{ pages, entities }`, which under a per-entity
// reading is a claim about two entity types the coach does not have: "pages" is
// not an entity at all, and "entities" is a run total wearing an entity's name. A
// coach reconciling their migration cannot tell from that whether the notes came
// across, only that *something* did. The engine already tracks the real split
// per step; these tests pin that it is exposed truthfully.

const ORIGIN = "https://src.example";
const ALLOWED = [ORIGIN];

function blueprint(steps, budgets) {
    return {
        platform: "test",
        apiBase: `${ORIGIN}/api`,
        rateLimitMs: 0,
        steps,
        budgets: { maxPages: 50, maxPagesPerStep: 20, maxEntities: 500, requestTimeoutMs: 1000, ...budgets },
    };
}

function run(fetchJson, { steps, budgets } = {}) {
    return runReplay({
        blueprint: blueprint(steps, budgets),
        fetchJson,
        emit: () => {},
        sleep: () => Promise.resolve(),
        allowedOrigins: ALLOWED,
    });
}

const step = (over) => ({ template: "/things", itemsPath: ["items"], idField: "id", ...over });

describe("runReplay — result.counts is a per-entity tally", () => {
    it("keys the tally by entityType, not by a pages/entities pseudo-pair", async () => {
        const result = await run(vi.fn().mockResolvedValue({ items: [{ id: "a" }, { id: "b" }] }), {
            steps: [step({ id: "things", entityType: "thing" })],
        });
        expect(result.counts).toEqual({ thing: 2 });
        expect("pages" in result.counts).toBe(false);
        expect("entities" in result.counts).toBe(false);
    });

    it("splits the total across entity types rather than collapsing it", async () => {
        const fetchJson = vi.fn(async (url) => (url.includes("/notes")
            ? { items: [{ id: "n1" }] }
            : { items: [{ id: "c1" }, { id: "c2" }] }));
        const result = await run(fetchJson, {
            steps: [
                step({ id: "clients", entityType: "client", template: "/clients", collectAs: "ids" }),
                step({ id: "notes", entityType: "note", template: "/clients/:id/notes", forEach: "ids" }),
            ],
        });
        expect(result.counts).toEqual({ client: 2, note: 2 });
        expect(result.entities).toBe(4);
    });

    it("sums two steps that feed the same entityType", async () => {
        const fetchJson = vi.fn(async (url) => (url.includes("/archived")
            ? { items: [{ id: "b" }] }
            : { items: [{ id: "a" }] }));
        const result = await run(fetchJson, {
            steps: [
                step({ id: "live", entityType: "client", template: "/clients" }),
                step({ id: "archived", entityType: "client", template: "/archived" }),
            ],
        });
        expect(result.counts).toEqual({ client: 2 });
    });

    it("reports a step that yielded nothing as 0 instead of dropping it", async () => {
        // A silently absent key reads as "not attempted". An explicit 0 is what
        // makes a drifted step visible in the settled record.
        const fetchJson = vi.fn(async (url) => (url.includes("/notes")
            ? { items: [] }
            : { items: [{ id: "c1" }] }));
        const result = await run(fetchJson, {
            steps: [
                step({ id: "clients", entityType: "client", template: "/clients", collectAs: "ids" }),
                step({ id: "notes", entityType: "note", template: "/clients/:id/notes", forEach: "ids" }),
            ],
        });
        expect(result.counts).toEqual({ client: 1, note: 0 });
    });

    it("keeps an entityType of __proto__ as a real own property", async () => {
        // entityType is adapter DATA (auto-inferred from untrusted capture in
        // PR-C2). Assigning it onto a bare object literal would set the prototype
        // and silently discard the count instead of reporting it.
        const result = await run(vi.fn().mockResolvedValue({ items: [{ id: "a" }] }), {
            steps: [step({ id: "odd", entityType: "__proto__" })],
        });
        expect(Object.hasOwn(result.counts, "__proto__")).toBe(true);
        expect(result.counts["__proto__"]).toBe(1);
        expect(Object.getPrototypeOf(result.counts)).toBe(Object.prototype);
    });

    it("reports the counts committed so far on a cancelled run", async () => {
        const controller = new AbortController();
        const fetchJson = vi.fn(async () => {
            controller.abort(); // the coach stops the run after the first page
            return { items: [{ id: "a" }] };
        });
        const result = await runReplay({
            blueprint: blueprint([
                step({ id: "things", entityType: "thing" }),
                step({ id: "others", entityType: "other", template: "/others" }),
            ]),
            fetchJson,
            emit: () => {},
            sleep: () => Promise.resolve(),
            signal: controller.signal,
            allowedOrigins: ALLOWED,
        });
        expect(result.status).toBe("cancelled");
        expect(result.counts).toEqual({ thing: 1, other: 0 });
    });
});
