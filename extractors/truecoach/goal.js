// /clients/{id}/goal — the CURVEBALL endpoint. It returns an HTML FRAGMENT
// (HTMX server-rendered), NOT JSON. The extractor detects content-type and
// parses with DOMParser. The fragment carries a `goal-row` div whose cells hold
// the macro values (calories, protein, carbs, fat, weight, sleep, steps,
// energy, hunger, stress). When no goals are set every cell is `<p>--</p>` (or
// the goal-row is absent entirely) — in that case we emit ZERO entities.
import { makeEntity } from "../_interface.js";
import { PLATFORM, isRecord } from "./parse.js";
// Macro fields we attempt to read from the goal-row, in cell order.
export const GOAL_FIELDS = [
    "calories",
    "protein",
    "carbs",
    "fat",
    "weight",
    "sleep",
    "steps",
    "energy",
    "hunger",
    "stress",
];
export function looksLikeHtml(contentType, body) {
    if (contentType && contentType.toLowerCase().includes("text/html")) {
        return true;
    }
    if (contentType && contentType.toLowerCase().includes("application/json")) {
        return false;
    }
    // No/ambiguous content-type: sniff the body. A JSON object/array starts with
    // { or [ after trimming; an HTML fragment starts with < .
    const trimmed = body.trimStart();
    return trimmed.startsWith("<");
}
// A value is "unset" when it is empty or the TrueCoach dash placeholder.
function isUnset(value) {
    const v = value.trim();
    return v === "" || v === "--" || v === "—";
}
// Parse the goal fragment. `doc` is produced by the caller via
// `new DOMParser().parseFromString(html, "text/html")` so this stays pure and
// testable (a jsdom Document satisfies the same DOM contract).
export function parseGoalDocument(doc, clientId) {
    const row = doc.querySelector(".goal-row");
    if (!row) {
        return null; // empty-state fragment: no goal-row rendered
    }
    const cells = Array.from(row.querySelectorAll("[data-goal-field], .goal-cell, td, p"));
    const values = {};
    let anySet = false;
    for (const cell of cells) {
        const field = cell.getAttribute("data-goal-field");
        const text = (cell.textContent ?? "").trim();
        if (field) {
            values[field] = text;
            if (!isUnset(text)) {
                anySet = true;
            }
        }
    }
    // Fall back to positional cell order when fields are not labelled.
    if (Object.keys(values).length === 0) {
        const texts = cells.map((c) => (c.textContent ?? "").trim()).filter((t) => t.length > 0);
        texts.forEach((text, idx) => {
            const field = GOAL_FIELDS[idx];
            if (field) {
                values[field] = text;
                if (!isUnset(text)) {
                    anySet = true;
                }
            }
        });
    }
    if (!anySet) {
        return null; // all dashes / empty -> emit nothing
    }
    return makeEntity(PLATFORM, `goal-${clientId}`, { kind: "goal", client_id: clientId, values });
}
// Bridge used at runtime in the content-script context where DOMParser exists.
export function parseGoalHtml(html, clientId) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return parseGoalDocument(doc, clientId);
}
// Defensive guard so a JSON goal (should it ever appear) does not crash the run.
export function isJsonGoal(raw) {
    return isRecord(raw) && "goal" in raw;
}
