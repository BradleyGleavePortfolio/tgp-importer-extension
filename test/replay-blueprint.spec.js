import { describe, it, expect } from "vitest";
import {
    normalizeBlueprint,
    readPath,
    extractItems,
    DEFAULT_BUDGETS,
} from "../shared/replay/blueprint.js";

// normalizeBlueprint is the fail-closed gate: a structurally invalid descriptor
// throws BEFORE any network call, so a bad blueprint can never launch a crawl.
// These tests pin both the accepted defaults and every rejection path.

function base(extra = {}) {
    return {
        platform: "test",
        apiBase: "https://api.test/base",
        steps: [{ id: "s", entityType: "thing", template: "/things" }],
        ...extra,
    };
}

describe("normalizeBlueprint — defaults", () => {
    it("fills method, itemsPath, idField, budgets, and strips trailing slash", () => {
        const bp = normalizeBlueprint(base({ apiBase: "https://api.test/base/" }));
        expect(bp.apiBase).toBe("https://api.test/base");
        expect(bp.steps[0].method).toBe("GET");
        expect(bp.steps[0].itemsPath).toEqual([]);
        expect(bp.steps[0].idField).toBe("id");
        expect(bp.steps[0].pagination).toBeNull();
        expect(bp.budgets).toEqual(DEFAULT_BUDGETS);
        expect(bp.rateLimitMs).toBe(0);
    });

    it("uppercases and accepts HEAD as a safe method", () => {
        const bp = normalizeBlueprint(base({ steps: [{ id: "s", entityType: "t", template: "/t", method: "head" }] }));
        expect(bp.steps[0].method).toBe("HEAD");
    });

    it("clamps invalid budget entries back to the defaults", () => {
        const bp = normalizeBlueprint(base({ budgets: { maxPages: -5, maxEntities: 0, maxPagesPerStep: 3.5 } }));
        expect(bp.budgets.maxPages).toBe(DEFAULT_BUDGETS.maxPages);
        expect(bp.budgets.maxEntities).toBe(DEFAULT_BUDGETS.maxEntities);
        expect(bp.budgets.maxPagesPerStep).toBe(DEFAULT_BUDGETS.maxPagesPerStep);
    });

    it("honours a partial budget override and defaults the rest", () => {
        const bp = normalizeBlueprint(base({ budgets: { maxPages: 10 } }));
        expect(bp.budgets.maxPages).toBe(10);
        expect(bp.budgets.maxEntities).toBe(DEFAULT_BUDGETS.maxEntities);
        expect(bp.budgets.maxPagesPerStep).toBe(DEFAULT_BUDGETS.maxPagesPerStep);
    });

    it("preserves a valid rateLimitMs and floors a negative one to 0", () => {
        expect(normalizeBlueprint(base({ rateLimitMs: 750 })).rateLimitMs).toBe(750);
        expect(normalizeBlueprint(base({ rateLimitMs: -1 })).rateLimitMs).toBe(0);
        expect(normalizeBlueprint(base({ rateLimitMs: "fast" })).rateLimitMs).toBe(0);
    });

    it("falls back to [] when itemsPath contains a non-string entry", () => {
        const bp = normalizeBlueprint(base({ steps: [{ id: "s", entityType: "t", template: "/t", itemsPath: ["a", 2] }] }));
        expect(bp.steps[0].itemsPath).toEqual([]);
    });

    it("round-trips collectAs and forEach through normalization", () => {
        const bp = normalizeBlueprint(base({
            steps: [
                { id: "p", entityType: "p", template: "/p", collectAs: "pids" },
                { id: "c", entityType: "c", template: "/p/:id", forEach: "pids" },
            ],
        }));
        expect(bp.steps[0].collectAs).toBe("pids");
        expect(bp.steps[0].forEach).toBeNull();
        expect(bp.steps[1].forEach).toBe("pids");
        expect(bp.steps[1].collectAs).toBeNull();
    });
});

describe("normalizeBlueprint — pagination", () => {
    it("defaults page pagination param/start", () => {
        const bp = normalizeBlueprint(base({ steps: [{ id: "s", entityType: "t", template: "/t", pagination: { style: "page" } }] }));
        expect(bp.steps[0].pagination).toEqual({ style: "page", param: "page", start: 1 });
    });

    it("requires nextPath for cursor pagination", () => {
        expect(() => normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "/t", pagination: { style: "cursor" } }],
        }))).toThrow(/nextPath/);
    });

    it("accepts a well-formed cursor descriptor", () => {
        const bp = normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "/t", pagination: { style: "cursor", nextPath: ["meta", "next"] } }],
        }));
        expect(bp.steps[0].pagination).toEqual({ style: "cursor", param: "cursor", nextPath: ["meta", "next"] });
    });
});

describe("normalizeBlueprint — rejections (fail closed)", () => {
    it("rejects a non-object", () => {
        expect(() => normalizeBlueprint(null)).toThrow(/must be an object/);
    });
    it("requires platform and apiBase", () => {
        expect(() => normalizeBlueprint(base({ platform: "" }))).toThrow(/platform/);
        expect(() => normalizeBlueprint(base({ apiBase: "" }))).toThrow(/apiBase/);
    });
    it("rejects a non-absolute apiBase", () => {
        expect(() => normalizeBlueprint(base({ apiBase: "/relative" }))).toThrow(/absolute URL/);
    });
    it("requires a non-empty steps array", () => {
        expect(() => normalizeBlueprint(base({ steps: [] }))).toThrow(/non-empty array/);
    });
    it("rejects a duplicate step id", () => {
        expect(() => normalizeBlueprint(base({
            steps: [
                { id: "dup", entityType: "a", template: "/a" },
                { id: "dup", entityType: "b", template: "/b" },
            ],
        }))).toThrow(/duplicated/);
    });
    it("rejects an unsafe method", () => {
        expect(() => normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "/t", method: "POST" }],
        }))).toThrow(/not a safe method/);
    });
    it("rejects a :param template with no forEach to fill it", () => {
        expect(() => normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "/t/:id" }],
        }))).toThrow(/no forEach/);
    });
    it("rejects a forEach that references an uncollected set", () => {
        expect(() => normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "/t/:id", forEach: "ghost" }],
        }))).toThrow(/not collected by any earlier step/);
    });
    it("rejects a forEach that references a LATER step's collectAs (ordering)", () => {
        expect(() => normalizeBlueprint(base({
            steps: [
                { id: "a", entityType: "a", template: "/a/:id", forEach: "later" },
                { id: "b", entityType: "b", template: "/b", collectAs: "later" },
            ],
        }))).toThrow(/not collected by any earlier step/);
    });
});

// ---------------------------------------------------------------------------
// SSRF / origin confinement. Blueprints will be produced by auto-inference from
// UNTRUSTED passive capture (PR-C2), so normalizeBlueprint must confine WHERE the
// credentialed crawl can go BEFORE any network call: https only, no IP-literal /
// loopback / link-local host, no embedded credentials, root-relative templates,
// and (when supplied) an apiBase origin on the caller's allowlist. These are the
// behavioral proofs of that boundary.
// ---------------------------------------------------------------------------

describe("normalizeBlueprint — scheme confinement (https only)", () => {
    it("accepts an https apiBase", () => {
        expect(() => normalizeBlueprint(base({ apiBase: "https://api.test/base" }))).not.toThrow();
    });
    for (const scheme of ["http", "ftp", "ws", "gopher"]) {
        it(`rejects a ${scheme}: apiBase`, () => {
            expect(() => normalizeBlueprint(base({ apiBase: `${scheme}://api.test/base` }))).toThrow(/https/);
        });
    }
    it("rejects a file: apiBase", () => {
        expect(() => normalizeBlueprint(base({ apiBase: "file:///etc/passwd" }))).toThrow(/https/);
    });
    it("rejects a data: apiBase", () => {
        expect(() => normalizeBlueprint(base({ apiBase: "data:text/plain,hello" }))).toThrow(/https/);
    });
});

describe("normalizeBlueprint — host confinement (no IP literals / loopback / link-local)", () => {
    for (const host of [
        "127.0.0.1", // loopback
        "10.0.0.5", // private class A
        "172.16.0.1", // private class B
        "192.168.1.1", // private class C
        "169.254.169.254", // link-local / cloud metadata
        "8.8.8.8", // public IPv4 literal — still refused (address by name only)
        "0.0.0.0", // unspecified
    ]) {
        it(`rejects IPv4 literal host ${host}`, () => {
            expect(() => normalizeBlueprint(base({ apiBase: `https://${host}/base` }))).toThrow(/not an allowed target/);
        });
    }
    for (const host of ["[::1]", "[fe80::1]", "[2001:db8::1]"]) {
        it(`rejects IPv6 literal host ${host}`, () => {
            expect(() => normalizeBlueprint(base({ apiBase: `https://${host}/base` }))).toThrow(/not an allowed target/);
        });
    }
    it("rejects localhost", () => {
        expect(() => normalizeBlueprint(base({ apiBase: "https://localhost/base" }))).toThrow(/not an allowed target/);
    });
    it("rejects a *.localhost subdomain", () => {
        expect(() => normalizeBlueprint(base({ apiBase: "https://svc.localhost/base" }))).toThrow(/not an allowed target/);
    });
    it("accepts an ordinary public hostname", () => {
        expect(() => normalizeBlueprint(base({ apiBase: "https://app.truecoach.co/proxy/api" }))).not.toThrow();
    });
});

describe("normalizeBlueprint — no embedded credentials in apiBase", () => {
    it("rejects a userinfo (user:pass@host) apiBase", () => {
        expect(() => normalizeBlueprint(base({ apiBase: "https://user:pass@api.test/base" }))).toThrow(/credentials/);
    });
    it("rejects a username-only apiBase", () => {
        expect(() => normalizeBlueprint(base({ apiBase: "https://user@api.test/base" }))).toThrow(/credentials/);
    });
});

describe("normalizeBlueprint — allowedOrigins allowlist (injected capability)", () => {
    it("accepts an apiBase whose origin is on the allowlist", () => {
        const bp = normalizeBlueprint(
            base({ apiBase: "https://api.test/base" }),
            { allowedOrigins: ["https://api.test"] },
        );
        expect(bp.apiBase).toBe("https://api.test/base");
    });
    it("rejects an apiBase whose origin is NOT on the allowlist", () => {
        expect(() => normalizeBlueprint(
            base({ apiBase: "https://evil.test/base" }),
            { allowedOrigins: ["https://api.test"] },
        )).toThrow(/allowlist/);
    });
    it("matches origins regardless of a trailing slash in the allowlist entry", () => {
        expect(() => normalizeBlueprint(
            base({ apiBase: "https://api.test/base" }),
            { allowedOrigins: ["https://api.test/"] },
        )).not.toThrow();
    });
    it("treats a differing port as a different origin (rejected)", () => {
        expect(() => normalizeBlueprint(
            base({ apiBase: "https://api.test:8443/base" }),
            { allowedOrigins: ["https://api.test"] },
        )).toThrow(/allowlist/);
    });
    it("accepts when one of several allowed origins matches", () => {
        expect(() => normalizeBlueprint(
            base({ apiBase: "https://b.test/base" }),
            { allowedOrigins: ["https://a.test", "https://b.test", "https://c.test"] },
        )).not.toThrow();
    });
    it("still applies intrinsic https/host checks even with an allowlist", () => {
        expect(() => normalizeBlueprint(
            base({ apiBase: "http://api.test/base" }),
            { allowedOrigins: ["http://api.test"] },
        )).toThrow(/https/);
    });
    it("rejects a malformed allowedOrigins entry", () => {
        expect(() => normalizeBlueprint(
            base({ apiBase: "https://api.test/base" }),
            { allowedOrigins: ["not a url"] },
        )).toThrow(/valid origin/);
    });
    it("rejects a non-array allowedOrigins", () => {
        expect(() => normalizeBlueprint(
            base({ apiBase: "https://api.test/base" }),
            { allowedOrigins: "https://api.test" },
        )).toThrow(/string\[\]/);
    });
    it("ignores an absent allowlist (intrinsic checks only)", () => {
        expect(() => normalizeBlueprint(base({ apiBase: "https://api.test/base" }), {})).not.toThrow();
    });
});

describe("normalizeBlueprint — step templates must be root-relative (no origin escape)", () => {
    it("accepts a root-relative path template", () => {
        expect(() => normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "/things/list" }],
        }))).not.toThrow();
    });
    it("rejects an absolute-url template", () => {
        expect(() => normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "https://evil.test/steal" }],
        }))).toThrow(/root-relative/);
    });
    it("rejects a protocol-relative //host template", () => {
        expect(() => normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "//evil.test/steal" }],
        }))).toThrow(/root-relative/);
    });
    it("rejects a template that does not start with /", () => {
        expect(() => normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "things" }],
        }))).toThrow(/root-relative/);
    });
    it("rejects a template embedding a scheme mid-string", () => {
        expect(() => normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "/redirect://evil.test" }],
        }))).toThrow(/root-relative/);
    });
});

describe("normalizeBlueprint — budgets + rate + apiBase detail", () => {
    it("defaults requestTimeoutMs and honours a valid override", () => {
        expect(normalizeBlueprint(base()).budgets.requestTimeoutMs).toBe(DEFAULT_BUDGETS.requestTimeoutMs);
        expect(normalizeBlueprint(base({ budgets: { requestTimeoutMs: 3000 } })).budgets.requestTimeoutMs).toBe(3000);
    });
    it("clamps a non-integer or non-positive requestTimeoutMs to the default", () => {
        expect(normalizeBlueprint(base({ budgets: { requestTimeoutMs: 0 } })).budgets.requestTimeoutMs)
            .toBe(DEFAULT_BUDGETS.requestTimeoutMs);
        expect(normalizeBlueprint(base({ budgets: { requestTimeoutMs: 12.5 } })).budgets.requestTimeoutMs)
            .toBe(DEFAULT_BUDGETS.requestTimeoutMs);
    });
    it("rejects a non-object budgets", () => {
        expect(() => normalizeBlueprint(base({ budgets: 5 }))).toThrow(/budgets must be an object/);
    });
    it("strips multiple trailing slashes from apiBase", () => {
        expect(normalizeBlueprint(base({ apiBase: "https://api.test/base///" })).apiBase).toBe("https://api.test/base");
    });
    it("preserves the platform label verbatim", () => {
        expect(normalizeBlueprint(base({ platform: "acme-crm" })).platform).toBe("acme-crm");
    });
    it("accepts a fractional rateLimitMs and preserves it", () => {
        expect(normalizeBlueprint(base({ rateLimitMs: 12.5 })).rateLimitMs).toBe(12.5);
    });
    it("preserves step order", () => {
        const bp = normalizeBlueprint(base({
            steps: [
                { id: "one", entityType: "a", template: "/a" },
                { id: "two", entityType: "b", template: "/b" },
                { id: "three", entityType: "c", template: "/c" },
            ],
        }));
        expect(bp.steps.map((s) => s.id)).toEqual(["one", "two", "three"]);
    });
});

describe("normalizeBlueprint — method + pagination detail", () => {
    it("defaults an omitted method to GET", () => {
        expect(normalizeBlueprint(base()).steps[0].method).toBe("GET");
    });
    it("uppercases a lowercase get", () => {
        const bp = normalizeBlueprint(base({ steps: [{ id: "s", entityType: "t", template: "/t", method: "get" }] }));
        expect(bp.steps[0].method).toBe("GET");
    });
    it("defaults cursor pagination param to 'cursor'", () => {
        const bp = normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "/t", pagination: { style: "cursor", nextPath: ["next"] } }],
        }));
        expect(bp.steps[0].pagination.param).toBe("cursor");
    });
    it("accepts a page pagination start of 0", () => {
        const bp = normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "/t", pagination: { style: "page", start: 0 } }],
        }));
        expect(bp.steps[0].pagination.start).toBe(0);
    });
    it("rejects a non-object pagination", () => {
        expect(() => normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "/t", pagination: 7 }],
        }))).toThrow(/pagination must be an object/);
    });
    it("copies the cursor nextPath array (no shared reference)", () => {
        const nextPath = ["meta", "next"];
        const bp = normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "/t", pagination: { style: "cursor", nextPath } }],
        }));
        expect(bp.steps[0].pagination.nextPath).toEqual(nextPath);
        expect(bp.steps[0].pagination.nextPath).not.toBe(nextPath);
    });
});

describe("normalizeBlueprint — fan-out chains", () => {
    it("allows two later steps to fan out over the same collected set", () => {
        const bp = normalizeBlueprint(base({
            steps: [
                { id: "p", entityType: "p", template: "/p", collectAs: "pids" },
                { id: "c1", entityType: "c1", template: "/p/:id/a", forEach: "pids" },
                { id: "c2", entityType: "c2", template: "/p/:id/b", forEach: "pids" },
            ],
        }));
        expect(bp.steps[1].forEach).toBe("pids");
        expect(bp.steps[2].forEach).toBe("pids");
    });
    it("allows a three-level collect -> fan-out -> collect -> fan-out chain", () => {
        expect(() => normalizeBlueprint(base({
            steps: [
                { id: "a", entityType: "a", template: "/a", collectAs: "aids" },
                { id: "b", entityType: "b", template: "/a/:id/b", forEach: "aids", collectAs: "bids" },
                { id: "c", entityType: "c", template: "/b/:id/c", forEach: "bids" },
            ],
        }))).not.toThrow();
    });
    it("defaults collectAs and forEach to null when absent", () => {
        const step = normalizeBlueprint(base()).steps[0];
        expect(step.collectAs).toBeNull();
        expect(step.forEach).toBeNull();
    });
});

describe("readPath / extractItems", () => {
    it("reads a nested value and returns undefined on a missing segment", () => {
        expect(readPath({ a: { b: 2 } }, ["a", "b"])).toBe(2);
        expect(readPath({ a: {} }, ["a", "b", "c"])).toBeUndefined();
        expect(readPath({ a: { b: 2 } }, [])).toEqual({ a: { b: 2 } });
    });
    it("extracts an array at itemsPath and yields [] for non-arrays", () => {
        expect(extractItems({ items: [1, 2] }, ["items"])).toEqual([1, 2]);
        expect(extractItems({ items: "nope" }, ["items"])).toEqual([]);
        expect(extractItems([1, 2, 3], [])).toEqual([1, 2, 3]);
        expect(extractItems({ a: 1 }, [])).toEqual([]);
    });
    it("descends a multi-segment itemsPath", () => {
        expect(extractItems({ data: { rows: [9] } }, ["data", "rows"])).toEqual([9]);
        expect(extractItems({ data: { rows: null } }, ["data", "rows"])).toEqual([]);
        expect(extractItems({ data: {} }, ["data", "rows"])).toEqual([]);
    });
    it("traverses array indices numerically", () => {
        expect(readPath([{ x: 1 }, { x: 2 }], ["1", "x"])).toBe(2);
        expect(readPath({ a: [10, 20] }, ["a", "0"])).toBe(10);
    });
    it("returns undefined when traversing through a primitive", () => {
        expect(readPath({ a: 5 }, ["a", "b"])).toBeUndefined();
        expect(readPath(null, ["a"])).toBeUndefined();
        expect(readPath("str", ["length"])).toBeUndefined();
    });
});

describe("normalizeBlueprint — step field preservation detail", () => {
    it("preserves a custom idField and defaults an absent one to 'id'", () => {
        const bp = normalizeBlueprint(base({
            steps: [
                { id: "a", entityType: "a", template: "/a", idField: "uuid" },
                { id: "b", entityType: "b", template: "/b" },
            ],
        }));
        expect(bp.steps[0].idField).toBe("uuid");
        expect(bp.steps[1].idField).toBe("id");
    });
    it("ignores a blank idField and falls back to 'id'", () => {
        const bp = normalizeBlueprint(base({ steps: [{ id: "a", entityType: "a", template: "/a", idField: "" }] }));
        expect(bp.steps[0].idField).toBe("id");
    });
    it("copies the itemsPath array (no shared reference)", () => {
        const itemsPath = ["data", "rows"];
        const bp = normalizeBlueprint(base({ steps: [{ id: "a", entityType: "a", template: "/a", itemsPath }] }));
        expect(bp.steps[0].itemsPath).toEqual(itemsPath);
        expect(bp.steps[0].itemsPath).not.toBe(itemsPath);
    });
    it("preserves entityType verbatim (envelope label, not normalized)", () => {
        const bp = normalizeBlueprint(base({ steps: [{ id: "a", entityType: "Client-Record", template: "/a" }] }));
        expect(bp.steps[0].entityType).toBe("Client-Record");
    });
    it("accepts a :param template when fed by an earlier forEach set", () => {
        expect(() => normalizeBlueprint(base({
            steps: [
                { id: "p", entityType: "p", template: "/p", collectAs: "pids" },
                { id: "c", entityType: "c", template: "/p/:id", forEach: "pids", idField: "id" },
            ],
        }))).not.toThrow();
    });
    it("treats an underscore-led :param as a real param needing a forEach", () => {
        expect(() => normalizeBlueprint(base({
            steps: [{ id: "s", entityType: "t", template: "/t/:_ref" }],
        }))).toThrow(/no forEach/);
    });
});

describe("normalizeBlueprint — allowlist edge detail", () => {
    it("rejects everything when the allowlist is present but empty", () => {
        expect(() => normalizeBlueprint(
            base({ apiBase: "https://api.test/base" }),
            { allowedOrigins: [] },
        )).toThrow(/allowlist/);
    });
    it("ignores extra opts keys and honours only allowedOrigins", () => {
        expect(() => normalizeBlueprint(
            base({ apiBase: "https://api.test/base" }),
            { allowedOrigins: ["https://api.test"], somethingElse: 1 },
        )).not.toThrow();
    });
    it("does not confuse a subdomain with an allowed parent origin", () => {
        expect(() => normalizeBlueprint(
            base({ apiBase: "https://evil.api.test/base" }),
            { allowedOrigins: ["https://api.test"] },
        )).toThrow(/allowlist/);
    });
    it("rejects a scheme-only allowlist entry with no host", () => {
        expect(() => normalizeBlueprint(
            base({ apiBase: "https://api.test/base" }),
            { allowedOrigins: ["https://"] },
        )).toThrow(/valid origin/);
    });
});

describe("normalizeBlueprint — return-shape guarantees", () => {
    it("returns exactly the documented top-level keys", () => {
        const bp = normalizeBlueprint(base());
        expect(Object.keys(bp).sort()).toEqual(["apiBase", "budgets", "platform", "rateLimitMs", "steps"]);
    });
    it("returns exactly the documented step keys", () => {
        const step = normalizeBlueprint(base()).steps[0];
        expect(Object.keys(step).sort())
            .toEqual(["collectAs", "entityType", "forEach", "id", "idField", "itemsPath", "method", "pagination", "template"]);
    });
    it("does not mutate the caller's input blueprint", () => {
        const input = base({ apiBase: "https://api.test/base/" });
        const snapshot = JSON.stringify(input);
        normalizeBlueprint(input);
        expect(JSON.stringify(input)).toBe(snapshot);
    });
});
