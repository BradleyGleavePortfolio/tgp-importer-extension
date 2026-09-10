import { describe, expect, it } from "vitest";
import { clusterResponseShapes, shapeSignature } from "../shared/blueprint/shapes.js";

describe("shapeSignature — stable structural identity", () => {
    it.each([
        [null, "null"],
        [true, "boolean"],
        [false, "boolean"],
        [0, "number"],
        [42.5, "number"],
        ["Dana Coach", "string"],
        [undefined, "unsupported"],
    ])("distinguishes the JSON type of %j", (value, signature) => {
        expect(shapeSignature(value)).toBe(signature);
    });

    it("distinguishes empty array and empty object", () => {
        expect(shapeSignature([])).toBe("array[]");
        expect(shapeSignature({})).toBe("object{}");
        expect(shapeSignature([])).not.toBe(shapeSignature({}));
    });

    it("is independent of object key insertion order", () => {
        const left = { name: "Dana", active: true, age: 40 };
        const right = { age: 12, active: false, name: "Sam" };
        expect(shapeSignature(left)).toBe(shapeSignature(right));
        expect(shapeSignature(left)).toBe("object{active:boolean,age:number,name:string}");
    });

    it("does not collapse unrelated schemas with equal type cardinalities", () => {
        const client = { id: 1, name: "Ada", active: true };
        const account = { age: 44, email: "x@y", verified: false };
        expect(shapeSignature(client)).not.toBe(shapeSignature(account));
        expect(clusterResponseShapes([{ body: client }, { body: account }])).toHaveLength(2);
    });

    it("is independent of array value order and duplicate values", () => {
        const left = [1, "private", true, 2, "different"];
        const right = [false, "other", 99];
        expect(shapeSignature(left)).toBe(shapeSignature(right));
        expect(shapeSignature(left)).toBe("array[boolean|number|string]");
    });

    it("distinguishes arrays with different element types", () => {
        expect(shapeSignature([1, 2])).not.toBe(shapeSignature(["1", "2"]));
        expect(shapeSignature([null])).not.toBe(shapeSignature([]));
        expect(shapeSignature([{ id: 1 }])).not.toBe(shapeSignature([[1]]));
    });

    it("distinguishes nested member types within the depth budget", () => {
        const strings = { client: { id: "private", enabled: true } };
        const numbers = { client: { id: 99, enabled: true } };
        expect(shapeSignature(strings, { maxDepth: 3 }))
            .toBe("object{client:object{enabled:boolean,id:string}}");
        expect(shapeSignature(strings, { maxDepth: 3 }))
            .not.toBe(shapeSignature(numbers, { maxDepth: 3 }));
    });

    it("uses a stable type marker beyond the depth bound", () => {
        const left = { client: { profile: { email: "dana@private.test" } } };
        const right = { client: { profile: { phone: "+1 555 0100" } } };
        expect(shapeSignature(left)).toBe(shapeSignature(right));
        expect(shapeSignature(left)).toBe("object{client:object{profile:object(*)}}");
    });

    it("supports a root-only depth budget", () => {
        expect(shapeSignature({ secret: "Dana" }, { maxDepth: 0 })).toBe("object(*)");
        expect(shapeSignature(["Dana"], { maxDepth: 0 })).toBe("array(*)");
    });

    it("does not contain scalar PII values", () => {
        const pii = [
            "Dana Coach",
            "dana@private.test",
            "+1 555 867 5309",
            "123 Main Street",
            "private medical note",
        ];
        const signature = shapeSignature({
            name: pii[0],
            email: pii[1],
            phone: pii[2],
            address: pii[3],
            notes: [pii[4]],
        }, { maxDepth: 4 });
        for (const value of pii) expect(signature).not.toContain(value);
        expect(signature).toBe(
            "object{address:string,email:string,name:string,notes:array[string],phone:string}",
        );
    });

    it("does not expose unsafe dynamic object keys", () => {
        const email = "dana@private.test";
        const uuid = "550e8400-e29b-41d4-a716-446655440000";
        const value = { [email]: true, [uuid]: false, ordinary_key: 1 };
        const signature = shapeSignature(value);
        expect(signature).not.toContain(email);
        expect(signature).not.toContain(uuid);
        expect(signature).toMatch(/^object\{#[a-z0-9]+:boolean,#[a-z0-9]+:boolean,#[a-z0-9]+:number\}$/);
    });

    it("does not expose prototype-like keys", () => {
        const value = JSON.parse("{\"__proto__\":1,\"constructor\":2,\"safe\":3}");
        const signature = shapeSignature(value);
        expect(signature).not.toContain("__proto__");
        expect(signature).not.toContain("constructor");
        expect(signature).toMatch(/^object\{#[a-z0-9]+:number,#[a-z0-9]+:number,safe:number\}$/);
    });

    it("classifies non-finite and non-JSON scalars as unsupported", () => {
        expect(shapeSignature(NaN)).toBe("unsupported");
        expect(shapeSignature(Infinity)).toBe("unsupported");
        expect(shapeSignature(1n)).toBe("unsupported");
        expect(shapeSignature(Symbol("private"))).toBe("unsupported");
        expect(shapeSignature(() => "private")).toBe("unsupported");
    });
});

describe("shapeSignature — bounded collection work", () => {
    it("returns an array overflow marker without inspecting excess elements", () => {
        const value = ["Dana", "Sam", "Taylor"];
        expect(shapeSignature(value, { maxCollection: 2 }))
            .toBe("array(overflow)");
    });

    it("returns an object overflow marker without exposing keys", () => {
        const value = {
            "dana@private.test": 1,
            "sam@private.test": 2,
            "taylor@private.test": 3,
        };
        const signature = shapeSignature(value, { maxCollection: 2 });
        expect(signature).toBe("object(overflow)");
        expect(signature).not.toContain("private");
    });

    it("bounds heterogeneous array variants deterministically", () => {
        const values = [null, true, 1, "private", {}, []];
        const reversed = [...values].reverse();
        const left = shapeSignature(values, { maxVariants: 2 });
        const right = shapeSignature(reversed, { maxVariants: 2 });
        expect(left).toBe(right);
        expect(left).toContain("...");
        expect(left).not.toContain("private");
    });

    it.each([
        [1, "array[boolean|...]"],
        [2, "array[boolean|null|...]"],
        [3, "array[boolean|null|number]"],
    ])("enforces maxVariants at limit-1/limit/limit+1 (%i)", (maxVariants, expected) => {
        expect(shapeSignature([null, true, 1], { maxVariants })).toBe(expected);
    });

    it.each([
        [1, "object{nested:object(*)}"],
        [2, "object{nested:object{value:number}}"],
        [3, "object{nested:object{value:number}}"],
    ])("enforces maxDepth at below/equal/above needed depth (%i)", (maxDepth, expected) => {
        expect(shapeSignature({ nested: { value: 1 } }, { maxDepth })).toBe(expected);
    });

    it.each([
        [1, "work(overflow)"],
        [2, "object{value:number}"],
        [3, "object{value:number}"],
    ])("enforces maxNodes at below/equal/above needed work (%i)", (maxNodes, expected) => {
        expect(shapeSignature({ value: 1 }, { maxNodes })).toBe(expected);
    });

    it("handles cycles defensively even though normalized JSON cannot contain them", () => {
        const value = {};
        value.self = value;
        expect(shapeSignature(value, { maxDepth: 4 }))
            .toBe("object{self:object(cycle)}");
    });

    it("uses defaults when numeric options are invalid", () => {
        const value = { nested: { deep: { private: "Dana" } } };
        expect(shapeSignature(value, {
            maxDepth: -1,
            maxCollection: 0,
            maxVariants: "many",
        })).toBe("object{nested:object{deep:object(*)}}");
    });

    it("does not recurse into a huge array past the collection check", () => {
        const value = Array.from({ length: 101 }, (_, index) => `private-${index}`);
        expect(shapeSignature(value)).toBe("array(overflow)");
    });
});

describe("clusterResponseShapes", () => {
    it("clusters equivalent bodies independent of key order and PII values", () => {
        const observations = [
            { body: { id: 1, name: "Dana Coach", email: "dana@private.test" } },
            { body: { email: "sam@private.test", name: "Sam Lift", id: 2 } },
        ];
        expect(clusterResponseShapes(observations)).toEqual([{
            origin: null,
            method: null,
            signature: "object{email:string,id:number,name:string}",
            observations: 2,
        }]);
    });

    it("separates object, array, scalar, and null response shapes", () => {
        const result = clusterResponseShapes([
            { body: {} },
            { body: [] },
            { body: "private" },
            { body: null },
        ]);
        expect(result).toEqual([
            { origin: null, method: null, signature: "array[]", observations: 1 },
            { origin: null, method: null, signature: "null", observations: 1 },
            { origin: null, method: null, signature: "object{}", observations: 1 },
            { origin: null, method: null, signature: "string", observations: 1 },
        ]);
    });

    it("is byte-identical regardless of observation order", () => {
        const observations = [
            { body: { id: 1, active: true } },
            { body: [{ id: 2 }] },
            { body: null },
            { body: { active: false, id: 3 } },
        ];
        expect(JSON.stringify(clusterResponseShapes(observations)))
            .toBe(JSON.stringify(clusterResponseShapes([...observations].reverse())));
    });

    it("never includes captured scalar values in clustered evidence", () => {
        const secret = "Dana Coach dana@private.test private-health-note";
        const result = clusterResponseShapes([
            { body: { profile: { value: secret }, values: [secret] } },
        ], { maxDepth: 4 });
        expect(JSON.stringify(result)).not.toContain(secret);
    });

    it("treats a missing body as unsupported rather than throwing", () => {
        expect(clusterResponseShapes([{}])).toEqual([
            { origin: null, method: null, signature: "unsupported", observations: 1 },
        ]);
    });

    it("returns no clusters for non-array input", () => {
        expect(clusterResponseShapes(null)).toEqual([]);
        expect(clusterResponseShapes({ body: {} })).toEqual([]);
    });

    it("bounds the number of observations inspected", () => {
        const result = clusterResponseShapes([
            { body: null },
            { body: true },
            { body: 1 },
        ], { maxObservations: 2 });
        expect(result).toEqual([
            { origin: null, method: null, signature: "boolean", observations: 1 },
            { origin: null, method: null, signature: "null", observations: 1 },
        ]);
    });

    it("passes depth and collection limits through to signatures", () => {
        const result = clusterResponseShapes([
            { body: { a: 1, b: 2 } },
            { body: ["private", 1] },
        ], { maxCollection: 1 });
        expect(result).toEqual([
            { origin: null, method: null, signature: "array(overflow)", observations: 1 },
            { origin: null, method: null, signature: "object(overflow)", observations: 1 },
        ]);
    });

    it("partitions equivalent shapes by origin and method provenance", () => {
        const result = clusterResponseShapes([
            { origin: "https://one.example", method: "GET", body: { id: 1 } },
            { origin: "https://two.example", method: "GET", body: { id: 2 } },
            { origin: "https://one.example", method: "HEAD", body: { id: 3 } },
        ]);
        expect(result).toEqual([
            {
                origin: "https://one.example",
                method: "GET",
                signature: "object{id:number}",
                observations: 1,
            },
            {
                origin: "https://one.example",
                method: "HEAD",
                signature: "object{id:number}",
                observations: 1,
            },
            {
                origin: "https://two.example",
                method: "GET",
                signature: "object{id:number}",
                observations: 1,
            },
        ]);
    });

    it("preserves privacy-safe field identity and child types", () => {
        expect(shapeSignature({ DanaCoach: true }))
            .toMatch(/^object\{#[a-z0-9]+:boolean\}$/);
        expect(shapeSignature({ DanaCoach: true, SamLift: false }))
            .not.toBe(shapeSignature({ DanaCoach: true }));
        expect(shapeSignature({ DanaCoach: true, SamLift: 2 }))
            .not.toBe(shapeSignature({ DanaCoach: true, SamLift: false }));
    });

    it.each([
        "DanaCoach", "dana_coach", "+15550100", "abc123", "Ｄａｎａ", "é", "e\u0301",
    ])("never emits arbitrary object key %s", (key) => {
        const signature = shapeSignature({ nested: { [key]: { id: 1 } } }, { maxDepth: 4 });
        expect(signature).toMatch(/^object\{nested:object\{#[a-z0-9]+:object\{id:number\}\}\}$/);
        expect(signature).not.toContain(key);
    });

    it("clamps extreme depth options and never overflows the JavaScript stack", () => {
        const root = {};
        let cursor = root;
        for (let i = 0; i < 12000; i += 1) {
            cursor.next = {};
            cursor = cursor.next;
        }
        expect(() => shapeSignature(root, {
            maxDepth: Number.MAX_SAFE_INTEGER,
            maxCollection: Number.MAX_SAFE_INTEGER,
            maxNodes: Number.MAX_SAFE_INTEGER,
        })).not.toThrow();
        expect(shapeSignature(root, { maxDepth: Number.MAX_SAFE_INTEGER }))
            .toContain("object(*)");
    });

    it.each([
        [1, "object{#75o54p:number}"],
        [2, "object{#6vojfq:number,#75o54p:number}"],
        [3, "object(overflow)"],
    ])("enforces maxCollection at exact object boundary %i", (count, expected) => {
        const value = Object.fromEntries(Array.from({ length: count }, (_, i) => [`private-${i}`, i]));
        expect(shapeSignature(value, { maxCollection: 2 })).toBe(expected);
    });

    it("selects a canonical bounded subset for every observation permutation", () => {
        const rows = [
            { origin: "https://x.example", method: "GET", body: null },
            { origin: "https://x.example", method: "GET", body: true },
            { origin: "https://x.example", method: "GET", body: 1 },
        ];
        expect(clusterResponseShapes(rows, { maxObservations: 2 }))
            .toEqual(clusterResponseShapes([...rows].reverse(), { maxObservations: 2 }));
    });

    it.each([
        [1, 1], [2, 2], [3, 2],
    ])("enforces maxObservations at limit-1/limit/limit+1 (%i)", (count, kept) => {
        const rows = Array.from({ length: count }, (_, i) => ({
            origin: "https://x.example",
            method: "GET",
            body: i === 0 ? null : i === 1,
        }));
        const result = clusterResponseShapes(rows, { maxObservations: 2 });
        expect(result.reduce((sum, row) => sum + row.observations, 0)).toBe(kept);
    });
});
