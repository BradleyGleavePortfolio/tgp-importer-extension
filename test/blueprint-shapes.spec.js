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
        expect(signature).toBe("object{<key>:boolean,ordinary_key:number}");
    });

    it("does not expose prototype-like keys", () => {
        const value = JSON.parse("{\"__proto__\":1,\"constructor\":2,\"safe\":3}");
        const signature = shapeSignature(value);
        expect(signature).not.toContain("__proto__");
        expect(signature).not.toContain("constructor");
        expect(signature).toBe("object{<key>:number,safe:number}");
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
            { signature: "array[]", observations: 1 },
            { signature: "null", observations: 1 },
            { signature: "object{}", observations: 1 },
            { signature: "string", observations: 1 },
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
            { signature: "unsupported", observations: 1 },
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
            { signature: "boolean", observations: 1 },
            { signature: "null", observations: 1 },
        ]);
    });

    it("passes depth and collection limits through to signatures", () => {
        const result = clusterResponseShapes([
            { body: { a: 1, b: 2 } },
            { body: ["private", 1] },
        ], { maxCollection: 1 });
        expect(result).toEqual([
            { signature: "array(overflow)", observations: 1 },
            { signature: "object(overflow)", observations: 1 },
        ]);
    });
});
