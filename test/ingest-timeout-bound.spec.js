import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("background ingest transport is bounded", () => {
  it("routes scout ingest + complete through fetchWithTimeout", () => {
    const src = readFileSync(join(process.cwd(), "background.js"), "utf8");
    expect(src).toMatch(
      /import\s*\{\s*fetchWithTimeout,\s*isTimeout[^}]*\}\s*from\s*"\.\/shared\/net\.js"/,
    );
    expect(src).toMatch(
      /fetchWithTimeout\(\s*fetch,\s*`\$\{TGP_API_ORIGIN\}\/api\/scout\/ingest`/,
    );
    expect(src).toMatch(
      /fetchWithTimeout\(\s*fetch,\s*`\$\{TGP_API_ORIGIN\}\/api\/scout\/ingest\/complete`/,
    );
    expect(src).toMatch(
      /fetchWithTimeout\(\s*fetch,\s*`\$\{TGP_API_ORIGIN\}\/api\/scout\/progress`/,
    );
    // No bare fetch( to tgp scout endpoints remain.
    expect(src).not.toMatch(/fetch\(`\$\{TGP_API_ORIGIN\}\/api\/scout\//);
  });

  it("manifest holds no cookies permission, no vendor host and no static content script", () => {
    const m = JSON.parse(
      readFileSync(join(process.cwd(), "manifest.json"), "utf8"),
    );
    expect(m.permissions).not.toContain("cookies");
    // Only TGP's own API is granted at install; every source origin is an
    // optional https grant the coach gives on the Start gesture.
    expect(m.host_permissions).toEqual([
      "https://backend-spring-lake-3890.fly.dev/*",
    ]);
    expect(m.optional_host_permissions).toEqual(["https://*/*"]);
    expect(m.content_scripts).toBeUndefined();
    // The collector is registered dynamically for the granted origin only.
    expect(m.permissions).toContain("scripting");
  });
});

describe("truecoach source fetch is bounded", () => {
  it("routes rawFetch through fetchWithTimeout", () => {
    const src = readFileSync(
      join(process.cwd(), "legacy/truecoach/net.js"),
      "utf8",
    );
    expect(src).toMatch(/fetchWithTimeout/);
    expect(src).not.toMatch(
      /const res = await fetch\(`\$\{TRUECOACH_API_BASE\}/,
    );
  });
});
