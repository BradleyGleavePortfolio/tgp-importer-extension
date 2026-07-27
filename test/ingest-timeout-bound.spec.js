import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("background ingest transport is bounded", () => {
    it("routes scout ingest + complete through fetchWithTimeout", () => {
        const src = readFileSync(join(process.cwd(), "background.js"), "utf8");
        expect(src).toMatch(/import \{ fetchWithTimeout, isTimeout[^}]*\} from "\.\/shared\/net\.js"/);
        expect(src).toMatch(/fetchWithTimeout\(fetch, `\$\{TGP_API_ORIGIN\}\/api\/scout\/ingest`/);
        expect(src).toMatch(/fetchWithTimeout\(fetch, `\$\{TGP_API_ORIGIN\}\/api\/scout\/ingest\/complete`/);
        expect(src).toMatch(/fetchWithTimeout\(fetch, `\$\{TGP_API_ORIGIN\}\/api\/scout\/progress`/);
        // No bare fetch( to tgp scout endpoints remain.
        expect(src).not.toMatch(/fetch\(`\$\{TGP_API_ORIGIN\}\/api\/scout\//);
    });

    it("manifest drops unused cookies/scripting and cleartext truecoach wildcard", () => {
        const m = JSON.parse(readFileSync(join(process.cwd(), "manifest.json"), "utf8"));
        expect(m.permissions).not.toContain("cookies");
        expect(m.permissions).not.toContain("scripting");
        expect(m.host_permissions).not.toContain("*://*.truecoach.co/*");
        expect(m.host_permissions).toContain("https://*.truecoach.co/*");
        const matches = m.content_scripts[0].matches;
        expect(matches).not.toContain("*://*.truecoach.co/*");
        expect(matches).toContain("https://*.truecoach.co/*");
    });
});

describe("truecoach source fetch is bounded", () => {
    it("routes rawFetch through fetchWithTimeout", () => {
        const src = readFileSync(join(process.cwd(), "extractors/truecoach/net.js"), "utf8");
        expect(src).toMatch(/fetchWithTimeout/);
        expect(src).not.toMatch(/const res = await fetch\(`\$\{TRUECOACH_API_BASE\}/);
    });
});

