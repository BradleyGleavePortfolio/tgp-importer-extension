import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Static policy gate: auth tokens must NEVER be written to chrome.storage.local
// (disk-persisted). Token material lives in chrome.storage.session or worker
// memory only. This spec fails if any production source line couples
// chrome.storage.local with token handling, in either order.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["test", "node_modules", "docs", "scripts", ".git", ".github"]);

const LOCAL_THEN_TOKEN = /chrome\.storage\.local.*token/i;
const TOKEN_THEN_LOCAL = /token.*chrome\.storage\.local/i;

function jsFilesUnder(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            if (!SKIP_DIRS.has(name)) {
                out.push(...jsFilesUnder(full));
            }
        }
        else if (name.endsWith(".js") && !(dir === ROOT && SKIP_DIRS.has(name))) {
            out.push(full);
        }
    }
    return out;
}

describe("storage policy — no token ever touches chrome.storage.local", () => {
    const files = jsFilesUnder(ROOT).filter((f) => {
        const rel = f.slice(ROOT.length + 1);
        return ![...SKIP_DIRS].some((d) => rel.startsWith(`${d}/`) || rel.startsWith(`${d}\\`));
    });

    it("scans a non-empty production source set", () => {
        const rels = files.map((f) => f.slice(ROOT.length + 1));
        expect(rels).toContain("background.js");
        expect(rels).toContain(join("popup", "login.js"));
    });

    it("finds no line coupling chrome.storage.local with token handling", () => {
        const offenders = [];
        for (const file of files) {
            const lines = readFileSync(file, "utf8").split("\n");
            lines.forEach((line, i) => {
                if (LOCAL_THEN_TOKEN.test(line) || TOKEN_THEN_LOCAL.test(line)) {
                    offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
                }
            });
        }
        expect(offenders).toEqual([]);
    });

    it("the background worker is the sole owner of refresh-token storage.session I/O", () => {
        const background = readFileSync(join(ROOT, "background.js"), "utf8");
        expect(background).toContain("chrome.storage.session.set({ [STORAGE_KEYS.refreshToken]: refreshToken })");
        expect(background).toContain("chrome.storage.session.get(STORAGE_KEYS.refreshToken)");
        expect(background).toContain("chrome.storage.session.remove(STORAGE_KEYS.refreshToken)");
    });

    it("the login popup relays the token pair to the worker and never calls chrome.storage", () => {
        const login = readFileSync(join(ROOT, "popup", "login.js"), "utf8");
        expect(login).toContain('kind: "session_established"');
        // The popup owns no session state — the single ownership boundary lives
        // in the background worker, so the popup must not invoke any storage API
        // (prose comments referencing storage are fine; API calls are not).
        expect(login).not.toMatch(/chrome\.storage\.(local|session|sync)\.\w+/);
    });
});
