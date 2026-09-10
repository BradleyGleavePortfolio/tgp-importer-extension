import { describe, it, expect, vi } from "vitest";
import {
  normalizeBlueprint as normalizeBlueprintStrict,
  readPath,
  extractItems,
  DEFAULT_BUDGETS,
  HARD_BUDGETS,
} from "../shared/replay/blueprint.js";
import { runReplay } from "../shared/replay/engine.js";

// normalizeBlueprint is the fail-closed gate: a structurally invalid descriptor
// throws BEFORE any network call, so a bad blueprint can never launch a crawl.
// These tests pin both the accepted defaults and every rejection path.
//
// allowedOrigins is now a REQUIRED capability (name-based SSRF confinement — a
// parse-time gate cannot prove a NAME won't resolve to a private target, so the
// only safe rule is "reach exactly the origins the trusted caller observed").
// The strict entrypoint (`normalizeBlueprintStrict`) is exercised directly by the
// mandatory-allowlist tests below. For the ~70 structural tests that only care
// about schema shape, this convenience wrapper derives a safe allowlist from the
// apiBase origin so each test does not have to restate it. When opts is supplied
// the wrapper passes it through untouched, so allowlist behavior is tested faithfully.

function normalizeBlueprint(bp, opts) {
  if (opts !== undefined) {
    return normalizeBlueprintStrict(bp, opts);
  }
  const allowedOrigins = ["https://allow.invalid"];
  try {
    const u = new URL(bp.apiBase);
    if (u.protocol === "https:") {
      allowedOrigins.push(u.origin);
    }
  } catch {
    // Non-absolute apiBase: leave the sentinel only; the strict entrypoint's
    // intrinsic apiBase check will reject with the expected message.
    void 0;
  }
  return normalizeBlueprintStrict(bp, { allowedOrigins });
}

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
    const bp = normalizeBlueprint(
      base({
        steps: [{ id: "s", entityType: "t", template: "/t", method: "head" }],
      }),
    );
    expect(bp.steps[0].method).toBe("HEAD");
  });

  it("clamps invalid budget entries back to the defaults", () => {
    const bp = normalizeBlueprint(
      base({ budgets: { maxPages: -5, maxEntities: 0, maxPagesPerStep: 3.5 } }),
    );
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
    expect(normalizeBlueprint(base({ rateLimitMs: 750 })).rateLimitMs).toBe(
      750,
    );
    expect(normalizeBlueprint(base({ rateLimitMs: -1 })).rateLimitMs).toBe(0);
    expect(normalizeBlueprint(base({ rateLimitMs: "fast" })).rateLimitMs).toBe(
      0,
    );
  });

  it("falls back to [] when itemsPath contains a non-string entry", () => {
    const bp = normalizeBlueprint(
      base({
        steps: [
          { id: "s", entityType: "t", template: "/t", itemsPath: ["a", 2] },
        ],
      }),
    );
    expect(bp.steps[0].itemsPath).toEqual([]);
  });

  it("round-trips collectAs and forEach through normalization", () => {
    const bp = normalizeBlueprint(
      base({
        steps: [
          { id: "p", entityType: "p", template: "/p", collectAs: "pids" },
          { id: "c", entityType: "c", template: "/p/:id", forEach: "pids" },
        ],
      }),
    );
    expect(bp.steps[0].collectAs).toBe("pids");
    expect(bp.steps[0].forEach).toBeNull();
    expect(bp.steps[1].forEach).toBe("pids");
    expect(bp.steps[1].collectAs).toBeNull();
  });
});

describe("normalizeBlueprint — immutable hard ceilings", () => {
  it.each(["maxPages", "maxPagesPerStep", "maxEntities", "requestTimeoutMs"])(
    "accepts the hard ceiling for %s and rejects larger declarations",
    (key) => {
      const atCeiling = normalizeBlueprint(
        base({
          budgets: { [key]: HARD_BUDGETS[key] },
        }),
      );
      const oneOver = normalizeBlueprint(
        base({
          budgets: { [key]: HARD_BUDGETS[key] + 1 },
        }),
      );
      const enormous = normalizeBlueprint(
        base({
          budgets: { [key]: Number.MAX_SAFE_INTEGER },
        }),
      );

      expect(atCeiling.budgets[key]).toBe(HARD_BUDGETS[key]);
      expect(oneOver.budgets[key]).toBe(DEFAULT_BUDGETS[key]);
      expect(enormous.budgets[key]).toBe(DEFAULT_BUDGETS[key]);
    },
  );

  it("accepts the rate-limit ceiling and rejects larger finite values", () => {
    const atCeiling = normalizeBlueprint(
      base({
        rateLimitMs: HARD_BUDGETS.rateLimitMs,
      }),
    );
    const oneOver = normalizeBlueprint(
      base({
        rateLimitMs: HARD_BUDGETS.rateLimitMs + 1,
      }),
    );
    const enormous = normalizeBlueprint(
      base({
        rateLimitMs: Number.MAX_VALUE,
      }),
    );

    expect(atCeiling.rateLimitMs).toBe(HARD_BUDGETS.rateLimitMs);
    expect(oneOver.rateLimitMs).toBe(0);
    expect(enormous.rateLimitMs).toBe(0);
  });
});

describe("normalizeBlueprint — pagination", () => {
  it("defaults page pagination param/start", () => {
    const bp = normalizeBlueprint(
      base({
        steps: [
          {
            id: "s",
            entityType: "t",
            template: "/t",
            pagination: { style: "page" },
          },
        ],
      }),
    );
    expect(bp.steps[0].pagination).toEqual({
      style: "page",
      param: "page",
      start: 1,
    });
  });

  it("requires nextPath for cursor pagination", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            {
              id: "s",
              entityType: "t",
              template: "/t",
              pagination: { style: "cursor" },
            },
          ],
        }),
      ),
    ).toThrow(/nextPath/);
  });

  it("accepts a well-formed cursor descriptor", () => {
    const bp = normalizeBlueprint(
      base({
        steps: [
          {
            id: "s",
            entityType: "t",
            template: "/t",
            pagination: { style: "cursor", nextPath: ["meta", "next"] },
          },
        ],
      }),
    );
    expect(bp.steps[0].pagination).toEqual({
      style: "cursor",
      param: "cursor",
      nextPath: ["meta", "next"],
    });
  });
});

describe("normalizeBlueprint — rejections (fail closed)", () => {
  it("rejects a non-object", () => {
    expect(() => normalizeBlueprint(null)).toThrow(/must be an object/);
  });
  it("requires platform and apiBase", () => {
    expect(() => normalizeBlueprint(base({ platform: "" }))).toThrow(
      /platform/,
    );
    expect(() => normalizeBlueprint(base({ apiBase: "" }))).toThrow(/apiBase/);
  });
  it("rejects a non-absolute apiBase", () => {
    expect(() => normalizeBlueprint(base({ apiBase: "/relative" }))).toThrow(
      /absolute URL/,
    );
  });
  it("requires a non-empty steps array", () => {
    expect(() => normalizeBlueprint(base({ steps: [] }))).toThrow(
      /non-empty array/,
    );
  });
  it("rejects a duplicate step id", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            { id: "dup", entityType: "a", template: "/a" },
            { id: "dup", entityType: "b", template: "/b" },
          ],
        }),
      ),
    ).toThrow(/duplicated/);
  });
  it("rejects an unsafe method", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "/t", method: "POST" }],
        }),
      ),
    ).toThrow(/not a safe method/);
  });
  it("rejects a :param template with no forEach to fill it", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "/t/:id" }],
        }),
      ),
    ).toThrow(/no forEach/);
  });
  it("rejects a forEach that references an uncollected set", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            { id: "s", entityType: "t", template: "/t/:id", forEach: "ghost" },
          ],
        }),
      ),
    ).toThrow(/not collected by any earlier step/);
  });
  it("rejects a forEach that references a LATER step's collectAs (ordering)", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            { id: "a", entityType: "a", template: "/a/:id", forEach: "later" },
            { id: "b", entityType: "b", template: "/b", collectAs: "later" },
          ],
        }),
      ),
    ).toThrow(/not collected by any earlier step/);
  });
  it("rejects a self-referential step whose collectAs equals its own forEach", () => {
    // Feeding a step's freshly-collected ids back into its own fan-out is a
    // self-amplifying crawl; reject it as structurally invalid up front.
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            {
              id: "seed",
              entityType: "seed",
              template: "/seed",
              collectAs: "loop",
            },
            {
              id: "loop",
              entityType: "node",
              template: "/n/:id",
              forEach: "loop",
              collectAs: "loop",
            },
          ],
        }),
      ),
    ).toThrow(/must not equal its own forEach/);
  });
});

// ---------------------------------------------------------------------------
// SSRF / origin confinement. Blueprints will be produced by auto-inference from
// UNTRUSTED passive capture (PR-C2), so normalizeBlueprint must confine WHERE the
// credentialed crawl can go BEFORE any network call: https only, no IP-literal /
// loopback / link-local host, no embedded credentials, root-relative templates,
// and a REQUIRED apiBase origin on the caller-injected allowlist. These are the
// behavioral proofs of that boundary.
// ---------------------------------------------------------------------------

describe("normalizeBlueprint — scheme confinement (https only)", () => {
  it("accepts an https apiBase", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://api.test/base" })),
    ).not.toThrow();
  });
  for (const scheme of ["http", "ftp", "ws", "gopher"]) {
    it(`rejects a ${scheme}: apiBase`, () => {
      expect(() =>
        normalizeBlueprint(base({ apiBase: `${scheme}://api.test/base` })),
      ).toThrow(/https/);
    });
  }
  it("rejects a file: apiBase", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "file:///etc/passwd" })),
    ).toThrow(/https/);
  });
  it("rejects a data: apiBase", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "data:text/plain,hello" })),
    ).toThrow(/https/);
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
      expect(() =>
        normalizeBlueprint(base({ apiBase: `https://${host}/base` })),
      ).toThrow(/not an allowed target/);
    });
  }
  for (const host of ["[::1]", "[fe80::1]", "[2001:db8::1]"]) {
    it(`rejects IPv6 literal host ${host}`, () => {
      expect(() =>
        normalizeBlueprint(base({ apiBase: `https://${host}/base` })),
      ).toThrow(/not an allowed target/);
    });
  }
  it("rejects localhost", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://localhost/base" })),
    ).toThrow(/not an allowed target/);
  });
  it("rejects a *.localhost subdomain", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://svc.localhost/base" })),
    ).toThrow(/not an allowed target/);
  });
  // A trailing-dot FQDN ("localhost.") resolves to the same loopback target, so
  // it must be judged by the same rule — strip the terminal dot before the check.
  it("rejects a trailing-dot localhost. FQDN", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://localhost./base" })),
    ).toThrow(/not an allowed target/);
  });
  it("rejects a trailing-dot *.localhost. FQDN", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://svc.localhost./base" })),
    ).toThrow(/not an allowed target/);
  });
  // Multi-dot FQDNs ("localhost..") resolve to the same loopback target on some
  // stacks, so the strip must remove EVERY terminal dot, not just one.
  for (const host of [
    "localhost..",
    "localhost...",
    "svc.localhost..",
    "localhost.%2e",
  ]) {
    it(`rejects a multi-trailing-dot ${host} FQDN`, () => {
      expect(() =>
        normalizeBlueprint(base({ apiBase: `https://${host}/base` })),
      ).toThrow(/not an allowed target/);
    });
  }
  // Numeric hosts with trailing dots canonicalize to (or strip down to) an IPv4
  // literal, which is refused wholesale.
  for (const host of ["127.0.0.1.", "127.0.0.1.."]) {
    it(`rejects trailing-dot IPv4 literal ${host}`, () => {
      expect(() =>
        normalizeBlueprint(base({ apiBase: `https://${host}/base` })),
      ).toThrow(/not an allowed target/);
    });
  }
  it("rejects an uppercase LOCALHOST", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://LOCALHOST/base" })),
    ).toThrow(/not an allowed target/);
  });
  it("accepts an ordinary public hostname", () => {
    expect(() =>
      normalizeBlueprint(
        base({ apiBase: "https://app.truecoach.co/proxy/api" }),
      ),
    ).not.toThrow();
  });
});

describe("normalizeBlueprint — no embedded credentials in apiBase", () => {
  it("rejects a userinfo (user:pass@host) apiBase", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://user:pass@api.test/base" })),
    ).toThrow(/credentials/);
  });
  it("rejects a username-only apiBase", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://user@api.test/base" })),
    ).toThrow(/credentials/);
  });
});

describe("normalizeBlueprint — allowedOrigins allowlist (injected capability)", () => {
  it("accepts an apiBase whose origin is on the allowlist", () => {
    const bp = normalizeBlueprint(base({ apiBase: "https://api.test/base" }), {
      allowedOrigins: ["https://api.test"],
    });
    expect(bp.apiBase).toBe("https://api.test/base");
  });
  it("rejects an apiBase whose origin is NOT on the allowlist", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://evil.test/base" }), {
        allowedOrigins: ["https://api.test"],
      }),
    ).toThrow(/allowlist/);
  });
  it("matches origins regardless of a trailing slash in the allowlist entry", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://api.test/base" }), {
        allowedOrigins: ["https://api.test/"],
      }),
    ).not.toThrow();
  });
  it("treats a differing port as a different origin (rejected)", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://api.test:8443/base" }), {
        allowedOrigins: ["https://api.test"],
      }),
    ).toThrow(/allowlist/);
  });
  it("accepts when one of several allowed origins matches", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://b.test/base" }), {
        allowedOrigins: ["https://a.test", "https://b.test", "https://c.test"],
      }),
    ).not.toThrow();
  });
  it("still applies intrinsic https/host checks even with an allowlist", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "http://api.test/base" }), {
        allowedOrigins: ["http://api.test"],
      }),
    ).toThrow(/https/);
  });
  it("rejects a malformed allowedOrigins entry", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://api.test/base" }), {
        allowedOrigins: ["not a url"],
      }),
    ).toThrow(/absolute URL/);
  });
  it("rejects a non-array allowedOrigins", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://api.test/base" }), {
        allowedOrigins: "https://api.test",
      }),
    ).toThrow(/string\[\]/);
  });
});

describe("normalizeBlueprint — step templates must be root-relative (no origin escape)", () => {
  it("accepts a root-relative path template", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "/things/list" }],
        }),
      ),
    ).not.toThrow();
  });
  it("rejects an absolute-url template", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            { id: "s", entityType: "t", template: "https://evil.test/steal" },
          ],
        }),
      ),
    ).toThrow(/root-relative/);
  });
  it("rejects a protocol-relative //host template", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "//evil.test/steal" }],
        }),
      ),
    ).toThrow(/root-relative/);
  });
  it("rejects a template that does not start with /", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "things" }],
        }),
      ),
    ).toThrow(/root-relative/);
  });
  // A "://" that lives INSIDE the path (not at the origin position) stays
  // on-origin under WHATWG URL join, so it is a benign path — not an escape.
  // The origin-escape proof (sentinel resolution) is authoritative; a blanket
  // includes("://") reject would only over-restrict legitimate paths.
  it("accepts a template whose path segment contains :// (stays on-origin)", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            { id: "s", entityType: "t", template: "/redirect://evil.test" },
          ],
        }),
      ),
    ).not.toThrow();
  });
  it("accepts a template carrying an https:// URL in a query value (on-origin)", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            {
              id: "s",
              entityType: "t",
              template: "/redirect?url=https://ok.test/x",
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
  it("still rejects a genuine origin escape even though the naive prefix passes", () => {
    // "//evil.test" would pass a startsWith("/") check but resolves off-origin;
    // the sentinel proof must still catch it.
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "//evil.test/steal" }],
        }),
      ),
    ).toThrow(/root-relative/);
  });
  // Under WHATWG URL join semantics a backslash aliases "/", so "/\host"
  // collapses to protocol-relative "//host" and escapes off-origin. A naive
  // startsWith("//") check misses it; the backslash reject + resolution-based
  // proof must catch it.
  it("rejects a leading-backslash template that would collapse to //host", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "/\\evil.test/steal" }],
        }),
      ),
    ).toThrow(/backslash|root-relative/);
  });
  it("rejects a /\\/host template", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            { id: "s", entityType: "t", template: "/\\/evil.test/steal" },
          ],
        }),
      ),
    ).toThrow(/backslash|root-relative/);
  });
  it("rejects any backslash anywhere in the template", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "/a/b\\c" }],
        }),
      ),
    ).toThrow(/backslash/);
  });
  // C0 control bytes (TAB/LF/CR) are stripped mid-parse, collapsing "/<TAB>/host"
  // into "//host" — an off-origin escape. Reject any control byte outright.
  for (const [label, ch] of [
    ["TAB", "\t"],
    ["LF", "\n"],
    ["CR", "\r"],
  ]) {
    it(`rejects a template containing a raw ${label} control byte`, () => {
      expect(() =>
        normalizeBlueprint(
          base({
            steps: [{ id: "s", entityType: "t", template: `/${ch}/evil.test` }],
          }),
        ),
      ).toThrow(/control characters|root-relative/);
    });
  }
  it("accepts a legitimate multi-segment root-relative template", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "/clients/list/all" }],
        }),
      ),
    ).not.toThrow();
  });
});

describe("normalizeBlueprint — budgets + rate + apiBase detail", () => {
  it("defaults requestTimeoutMs and honours a valid override", () => {
    expect(normalizeBlueprint(base()).budgets.requestTimeoutMs).toBe(
      DEFAULT_BUDGETS.requestTimeoutMs,
    );
    expect(
      normalizeBlueprint(base({ budgets: { requestTimeoutMs: 3000 } })).budgets
        .requestTimeoutMs,
    ).toBe(3000);
  });
  it("clamps a non-integer or non-positive requestTimeoutMs to the default", () => {
    expect(
      normalizeBlueprint(base({ budgets: { requestTimeoutMs: 0 } })).budgets
        .requestTimeoutMs,
    ).toBe(DEFAULT_BUDGETS.requestTimeoutMs);
    expect(
      normalizeBlueprint(base({ budgets: { requestTimeoutMs: 12.5 } })).budgets
        .requestTimeoutMs,
    ).toBe(DEFAULT_BUDGETS.requestTimeoutMs);
  });
  it("rejects a non-object budgets", () => {
    expect(() => normalizeBlueprint(base({ budgets: 5 }))).toThrow(
      /budgets must be an object/,
    );
  });
  it("strips multiple trailing slashes from apiBase", () => {
    expect(
      normalizeBlueprint(base({ apiBase: "https://api.test/base///" })).apiBase,
    ).toBe("https://api.test/base");
  });
  it("preserves the platform label verbatim", () => {
    expect(normalizeBlueprint(base({ platform: "acme-crm" })).platform).toBe(
      "acme-crm",
    );
  });
  it("accepts a fractional rateLimitMs and preserves it", () => {
    expect(normalizeBlueprint(base({ rateLimitMs: 12.5 })).rateLimitMs).toBe(
      12.5,
    );
  });
  it("preserves step order", () => {
    const bp = normalizeBlueprint(
      base({
        steps: [
          { id: "one", entityType: "a", template: "/a" },
          { id: "two", entityType: "b", template: "/b" },
          { id: "three", entityType: "c", template: "/c" },
        ],
      }),
    );
    expect(bp.steps.map((s) => s.id)).toEqual(["one", "two", "three"]);
  });
});

describe("normalizeBlueprint — method + pagination detail", () => {
  it("defaults an omitted method to GET", () => {
    expect(normalizeBlueprint(base()).steps[0].method).toBe("GET");
  });
  it("uppercases a lowercase get", () => {
    const bp = normalizeBlueprint(
      base({
        steps: [{ id: "s", entityType: "t", template: "/t", method: "get" }],
      }),
    );
    expect(bp.steps[0].method).toBe("GET");
  });
  it("defaults cursor pagination param to 'cursor'", () => {
    const bp = normalizeBlueprint(
      base({
        steps: [
          {
            id: "s",
            entityType: "t",
            template: "/t",
            pagination: { style: "cursor", nextPath: ["next"] },
          },
        ],
      }),
    );
    expect(bp.steps[0].pagination.param).toBe("cursor");
  });
  it("accepts a page pagination start of 0", () => {
    const bp = normalizeBlueprint(
      base({
        steps: [
          {
            id: "s",
            entityType: "t",
            template: "/t",
            pagination: { style: "page", start: 0 },
          },
        ],
      }),
    );
    expect(bp.steps[0].pagination.start).toBe(0);
  });
  it("rejects a non-object pagination", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "/t", pagination: 7 }],
        }),
      ),
    ).toThrow(/pagination must be an object/);
  });
  it("copies the cursor nextPath array (no shared reference)", () => {
    const nextPath = ["meta", "next"];
    const bp = normalizeBlueprint(
      base({
        steps: [
          {
            id: "s",
            entityType: "t",
            template: "/t",
            pagination: { style: "cursor", nextPath },
          },
        ],
      }),
    );
    expect(bp.steps[0].pagination.nextPath).toEqual(nextPath);
    expect(bp.steps[0].pagination.nextPath).not.toBe(nextPath);
  });
});

describe("normalizeBlueprint — fan-out chains", () => {
  it("allows two later steps to fan out over the same collected set", () => {
    const bp = normalizeBlueprint(
      base({
        steps: [
          { id: "p", entityType: "p", template: "/p", collectAs: "pids" },
          { id: "c1", entityType: "c1", template: "/p/:id/a", forEach: "pids" },
          { id: "c2", entityType: "c2", template: "/p/:id/b", forEach: "pids" },
        ],
      }),
    );
    expect(bp.steps[1].forEach).toBe("pids");
    expect(bp.steps[2].forEach).toBe("pids");
  });
  it("allows a three-level collect -> fan-out -> collect -> fan-out chain", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            { id: "a", entityType: "a", template: "/a", collectAs: "aids" },
            {
              id: "b",
              entityType: "b",
              template: "/a/:id/b",
              forEach: "aids",
              collectAs: "bids",
            },
            { id: "c", entityType: "c", template: "/b/:id/c", forEach: "bids" },
          ],
        }),
      ),
    ).not.toThrow();
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
    expect(extractItems({ data: { rows: [9] } }, ["data", "rows"])).toEqual([
      9,
    ]);
    expect(extractItems({ data: { rows: null } }, ["data", "rows"])).toEqual(
      [],
    );
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
    const bp = normalizeBlueprint(
      base({
        steps: [
          { id: "a", entityType: "a", template: "/a", idField: "uuid" },
          { id: "b", entityType: "b", template: "/b" },
        ],
      }),
    );
    expect(bp.steps[0].idField).toBe("uuid");
    expect(bp.steps[1].idField).toBe("id");
  });
  it("ignores a blank idField and falls back to 'id'", () => {
    const bp = normalizeBlueprint(
      base({
        steps: [{ id: "a", entityType: "a", template: "/a", idField: "" }],
      }),
    );
    expect(bp.steps[0].idField).toBe("id");
  });
  it("copies the itemsPath array (no shared reference)", () => {
    const itemsPath = ["data", "rows"];
    const bp = normalizeBlueprint(
      base({
        steps: [{ id: "a", entityType: "a", template: "/a", itemsPath }],
      }),
    );
    expect(bp.steps[0].itemsPath).toEqual(itemsPath);
    expect(bp.steps[0].itemsPath).not.toBe(itemsPath);
  });
  it("preserves entityType verbatim (envelope label, not normalized)", () => {
    const bp = normalizeBlueprint(
      base({
        steps: [{ id: "a", entityType: "Client-Record", template: "/a" }],
      }),
    );
    expect(bp.steps[0].entityType).toBe("Client-Record");
  });
  it("accepts a :param template when fed by an earlier forEach set", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            { id: "p", entityType: "p", template: "/p", collectAs: "pids" },
            {
              id: "c",
              entityType: "c",
              template: "/p/:id",
              forEach: "pids",
              idField: "id",
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
  it("treats an underscore-led :param as a real param needing a forEach", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "/t/:_ref" }],
        }),
      ),
    ).toThrow(/no forEach/);
  });
  // A digit-led placeholder (":1") must also be recognized as a param, so it is
  // not silently accepted without a forEach set to fill it.
  it("treats a digit-led :param as a real param needing a forEach", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "/t/:1" }],
        }),
      ),
    ).toThrow(/no forEach/);
  });
  it("accepts a digit-led :param when fed by an earlier forEach set", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            { id: "p", entityType: "p", template: "/p", collectAs: "pids" },
            {
              id: "c",
              entityType: "c",
              template: "/p/:1",
              forEach: "pids",
              idField: "id",
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

describe("normalizeBlueprint — allowlist edge detail", () => {
  it("rejects everything when the allowlist is present but empty", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://api.test/base" }), {
        allowedOrigins: [],
      }),
    ).toThrow(/string\[\]/);
  });
  it("ignores extra opts keys and honours only allowedOrigins", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://api.test/base" }), {
        allowedOrigins: ["https://api.test"],
        somethingElse: 1,
      }),
    ).not.toThrow();
  });
  it("does not confuse a subdomain with an allowed parent origin", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://evil.api.test/base" }), {
        allowedOrigins: ["https://api.test"],
      }),
    ).toThrow(/allowlist/);
  });
  it("rejects a scheme-only allowlist entry with no host", () => {
    expect(() =>
      normalizeBlueprint(base({ apiBase: "https://api.test/base" }), {
        allowedOrigins: ["https://"],
      }),
    ).toThrow(/absolute URL/);
  });
});

// The allowlist is now a REQUIRED capability, exercised against the STRICT
// entrypoint (no convenience-wrapper derivation). A parse-time gate cannot prove
// a hostname won't resolve to a private/link-local target, so the only safe rule
// is: a crawl may reach exactly the origins the trusted caller explicitly observed.
// Absence/empty must fail closed BEFORE any network call, and each allowed origin
// is itself validated so the allowlist cannot smuggle in an unsafe target.
describe("normalizeBlueprint — allowedOrigins is a required capability (name-based SSRF)", () => {
  it("rejects (fails closed) when opts is entirely absent", () => {
    expect(() => normalizeBlueprintStrict(base())).toThrow(/string\[\]/);
  });
  it("rejects when opts is present but carries no allowedOrigins", () => {
    expect(() => normalizeBlueprintStrict(base(), {})).toThrow(/string\[\]/);
  });
  it("rejects an empty allowedOrigins array", () => {
    expect(() =>
      normalizeBlueprintStrict(base(), { allowedOrigins: [] }),
    ).toThrow(/string\[\]/);
  });
  // A name that resolves to a link-local / private target (e.g. the cloud
  // metadata endpoint) passes every resolve-free literal check, so the ONLY
  // thing that stops it is the caller not having observed it.
  it("rejects a private-resolving NAME (metadata endpoint) when it is not explicitly allowed", () => {
    expect(() =>
      normalizeBlueprintStrict(
        base({ apiBase: "https://metadata.google.internal/x" }),
      ),
    ).toThrow(/string\[\]/);
  });
  it("rejects a private-resolving NAME when a DIFFERENT origin is allowed", () => {
    expect(() =>
      normalizeBlueprintStrict(
        base({ apiBase: "https://metadata.google.internal/x" }),
        { allowedOrigins: ["https://api.test"] },
      ),
    ).toThrow(/allowlist/);
  });
  it("accepts a private-resolving NAME ONLY when the caller explicitly observed it", () => {
    expect(() =>
      normalizeBlueprintStrict(
        base({ apiBase: "https://metadata.google.internal/x" }),
        { allowedOrigins: ["https://metadata.google.internal"] },
      ),
    ).not.toThrow();
  });
  // The allowlist itself is validated entry-by-entry so it cannot become the
  // smuggling vector for the very targets the host gate refuses.
  it("rejects a loopback allowlist entry", () => {
    expect(() =>
      normalizeBlueprintStrict(base(), {
        allowedOrigins: ["https://localhost"],
      }),
    ).toThrow(/not an allowed target/);
  });
  it("rejects an http (non-https) allowlist entry", () => {
    expect(() =>
      normalizeBlueprintStrict(base(), { allowedOrigins: ["http://api.test"] }),
    ).toThrow(/https/);
  });
  it("rejects an IP-literal allowlist entry", () => {
    expect(() =>
      normalizeBlueprintStrict(base(), {
        allowedOrigins: ["https://127.0.0.1"],
      }),
    ).toThrow(/not an allowed target/);
  });
  it("rejects a credentialed allowlist entry", () => {
    expect(() =>
      normalizeBlueprintStrict(base(), {
        allowedOrigins: ["https://user:pass@api.test"],
      }),
    ).toThrow(/credentials/);
  });
  it("rejects a non-string allowlist entry", () => {
    expect(() =>
      normalizeBlueprintStrict(base(), { allowedOrigins: [123] }),
    ).toThrow(/string\[\]/);
  });
});

describe("normalizeBlueprint — headers", () => {
  it("absent blueprint AND step headers normalize to {}", () => {
    const bp = normalizeBlueprint(base());
    expect(bp.headers).toEqual({});
    expect(bp.steps[0].headers).toEqual({});
  });
  it("keeps a valid blueprint-level header record", () => {
    const bp = normalizeBlueprint(
      base({ headers: { Accept: "application/json" } }),
    );
    expect(bp.headers).toEqual({ Accept: "application/json" });
  });
  it("keeps a valid per-step header record", () => {
    const bp = normalizeBlueprint(
      base({
        steps: [
          {
            id: "s",
            entityType: "t",
            template: "/t",
            headers: { Role: "Trainer" },
          },
        ],
      }),
    );
    expect(bp.steps[0].headers).toEqual({ Role: "Trainer" });
  });
  it("does not merge blueprint and step headers at normalize time (engine composes them)", () => {
    const bp = normalizeBlueprint(
      base({
        headers: { Accept: "application/json" },
        steps: [
          {
            id: "s",
            entityType: "t",
            template: "/t",
            headers: { Role: "Trainer" },
          },
        ],
      }),
    );
    expect(bp.headers).toEqual({ Accept: "application/json" });
    expect(bp.steps[0].headers).toEqual({ Role: "Trainer" });
  });
  it("rejects non-plain-object blueprint headers (array)", () => {
    expect(() => normalizeBlueprint(base({ headers: ["Accept"] }))).toThrow(
      /headers must be a plain object/,
    );
  });
  it("rejects non-plain-object step headers (array)", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [{ id: "s", entityType: "t", template: "/t", headers: [] }],
        }),
      ),
    ).toThrow(/headers must be a plain object/);
  });
  it("rejects an empty-string header value", () => {
    expect(() => normalizeBlueprint(base({ headers: { Accept: "" } }))).toThrow(
      /value must be a non-empty string/,
    );
  });
  it("rejects a non-string header value", () => {
    expect(() => normalizeBlueprint(base({ headers: { Accept: 5 } }))).toThrow(
      /value must be a non-empty string/,
    );
  });
  it("rejects a non-string header value on a step", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            {
              id: "s",
              entityType: "t",
              template: "/t",
              headers: { Role: null },
            },
          ],
        }),
      ),
    ).toThrow(/value must be a non-empty string/);
  });
  it("null headers are treated as absent, not an error", () => {
    const bp = normalizeBlueprint(base({ headers: null }));
    expect(bp.headers).toEqual({});
  });
  // Header-injection confinement: CR/LF/NUL/DEL (and other C0 controls) are the
  // request-splitting vector and must fail closed in BOTH names and values.
  it.each([
    ["CR", "\r"],
    ["LF", "\n"],
    ["NUL", "\x00"],
    ["DEL", "\x7F"],
  ])("rejects a %s control character in a header value", (_name, ch) => {
    expect(() =>
      normalizeBlueprint(
        base({ headers: { Accept: `application/json${ch}evil` } }),
      ),
    ).toThrow(/value must not contain control characters/);
  });
  it.each([
    ["CR", "\r"],
    ["LF", "\n"],
    ["NUL", "\x00"],
    ["DEL", "\x7F"],
  ])("rejects a %s control character in a header name", (_name, ch) => {
    expect(() =>
      normalizeBlueprint(base({ headers: { [`X${ch}Injected`]: "v" } })),
    ).toThrow(/must not contain control characters or backslashes/);
  });
  it("rejects a backslash in a header name (not a valid field-name token char)", () => {
    expect(() =>
      normalizeBlueprint(base({ headers: { "X\\Bad": "v" } })),
    ).toThrow(/must not contain control characters or backslashes/);
  });
  it("keeps a backslash in a header VALUE (legal field-content byte)", () => {
    const bp = normalizeBlueprint(
      base({ headers: { "User-Agent": "app\\1.0" } }),
    );
    expect(bp.headers["User-Agent"]).toBe("app\\1.0");
  });
  it("applies the same control-character guard to per-step headers", () => {
    expect(() =>
      normalizeBlueprint(
        base({
          steps: [
            {
              id: "s",
              entityType: "t",
              template: "/t",
              headers: { Role: "Trainer\r\nX: y" },
            },
          ],
        }),
      ),
    ).toThrow(/value must not contain control characters/);
  });
});

describe("normalizeBlueprint — return-shape guarantees", () => {
  it("returns exactly the documented top-level keys", () => {
    const bp = normalizeBlueprint(base());
    expect(Object.keys(bp).sort()).toEqual([
      "apiBase",
      "budgets",
      "headers",
      "platform",
      "rateLimitMs",
      "steps",
    ]);
  });
  it("returns exactly the documented step keys", () => {
    const step = normalizeBlueprint(base()).steps[0];
    expect(Object.keys(step).sort()).toEqual([
      "collectAs",
      "entityType",
      "forEach",
      "headers",
      "id",
      "idField",
      "itemsPath",
      "method",
      "pagination",
      "template",
    ]);
  });
  it("does not mutate the caller's input blueprint", () => {
    const input = base({ apiBase: "https://api.test/base/" });
    const snapshot = JSON.stringify(input);
    normalizeBlueprint(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// C2b-0A — the absent-vs-explicitly-malformed boundary. Pagination descriptors are
// auto-inferred from UNTRUSTED capture, so an ABSENT field must keep today's exact
// default while a PRESENT but invalid field must fail closed at normalization
// instead of being coerced into runnable page traversal.
function paginated(pagination) {
  return base({
    steps: [{ id: "s", entityType: "t", template: "/t", pagination }],
  });
}

describe("normalizeBlueprint — pagination: absent fields keep defaults", () => {
  it("treats an omitted pagination as no pagination", () => {
    expect(
      normalizeBlueprint(paginated(undefined)).steps[0].pagination,
    ).toBeNull();
    expect(normalizeBlueprint(paginated(null)).steps[0].pagination).toBeNull();
  });
  it("defaults an empty descriptor to the documented page descriptor", () => {
    expect(normalizeBlueprint(paginated({})).steps[0].pagination).toEqual({
      style: "page",
      param: "page",
      start: 1,
    });
  });
  it("treats explicit null/undefined page fields as absent", () => {
    for (const p of [
      { style: null, param: null, start: null },
      { style: undefined, param: undefined, start: undefined },
    ]) {
      expect(normalizeBlueprint(paginated(p)).steps[0].pagination).toEqual({
        style: "page",
        param: "page",
        start: 1,
      });
    }
  });
  it("defaults only the absent field of a partly specified descriptor", () => {
    expect(
      normalizeBlueprint(paginated({ param: "offset" })).steps[0].pagination,
    ).toEqual({ style: "page", param: "offset", start: 1 });
    expect(
      normalizeBlueprint(paginated({ style: "page", start: 7 })).steps[0]
        .pagination,
    ).toEqual({ style: "page", param: "page", start: 7 });
  });
});

describe("normalizeBlueprint — pagination: explicit malformed fails closed", () => {
  it("rejects an explicitly unknown style instead of coercing it to page", () => {
    for (const style of [
      "offset",
      "Page",
      "PAGE",
      "cursor ",
      "",
      1,
      true,
      ["page"],
      { style: "page" },
    ]) {
      expect(() => normalizeBlueprint(paginated({ style }))).toThrow(
        /pagination style must be "page" or "cursor"/,
      );
    }
  });
  it("rejects an explicitly empty or non-string param for either style", () => {
    for (const param of ["", 0, 5, true, [], {}]) {
      expect(() =>
        normalizeBlueprint(paginated({ style: "page", param })),
      ).toThrow(/pagination param must be a non-empty string/);
      expect(() =>
        normalizeBlueprint(
          paginated({ style: "cursor", param, nextPath: ["next"] }),
        ),
      ).toThrow(/pagination param must be a non-empty string/);
    }
  });
  it("rejects an explicitly non-integer page start", () => {
    for (const start of [
      1.5,
      -0.5,
      "2",
      "",
      true,
      NaN,
      Infinity,
      -Infinity,
      1e400,
      [1],
      {},
    ]) {
      expect(() =>
        normalizeBlueprint(paginated({ style: "page", start })),
      ).toThrow(/page pagination start must be an integer/);
    }
  });
  it("rejects an empty or malformed cursor nextPath", () => {
    for (const nextPath of [
      [],
      [""],
      ["meta", ""],
      ["meta", 1],
      ["meta", null],
      [["meta"]],
      "meta",
      {},
      7,
    ]) {
      expect(() =>
        normalizeBlueprint(paginated({ style: "cursor", nextPath })),
      ).toThrow(/cursor pagination requires a non-empty nextPath string\[\]/);
    }
  });
  it("rejects a malformed field inherited from a prototype (no silent default)", () => {
    const proto = { style: "offset" };
    expect(() => normalizeBlueprint(paginated(Object.create(proto)))).toThrow(
      /pagination style must be "page" or "cursor"/,
    );
    const startProto = Object.create({ start: 1.5 });
    startProto.style = "page";
    expect(() => normalizeBlueprint(paginated(startProto))).toThrow(
      /page pagination start must be an integer/,
    );
  });
});

describe("normalizeBlueprint — pagination: valid descriptors preserved", () => {
  it("keeps every currently valid page descriptor byte-exact", () => {
    for (const start of [0, 1, 2, -3, 1000000]) {
      expect(
        normalizeBlueprint(paginated({ style: "page", param: "p", start }))
          .steps[0].pagination,
      ).toEqual({ style: "page", param: "p", start });
    }
  });
  it("keeps a valid cursor descriptor byte-exact and still copies nextPath", () => {
    const nextPath = ["meta", "paging", "next"];
    const pag = normalizeBlueprint(
      paginated({ style: "cursor", param: "after", nextPath }),
    ).steps[0].pagination;
    expect(pag).toEqual({ style: "cursor", param: "after", nextPath });
    expect(pag.nextPath).not.toBe(nextPath);
    expect(Object.keys(pag).sort()).toEqual(["nextPath", "param", "style"]);
  });
  it("accepts a prototype-less descriptor record", () => {
    const p = Object.create(null);
    p.style = "cursor";
    p.nextPath = ["next"];
    expect(normalizeBlueprint(paginated(p)).steps[0].pagination).toEqual({
      style: "cursor",
      param: "cursor",
      nextPath: ["next"],
    });
  });
});

describe("runReplay — malformed pagination fails before any request", () => {
  it("throws at normalization, so the fetcher is never called", async () => {
    const fetchJson = vi.fn();
    await expect(
      runReplay({
        blueprint: paginated({ style: "offset" }),
        allowedOrigins: ["https://api.test"],
        fetchJson,
        emit: async () => {},
      }),
    ).rejects.toThrow(/pagination style must be "page" or "cursor"/);
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
