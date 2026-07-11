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
        expect(rels).toContain(join("shared", "session.js"));
        expect(rels).toContain(join("popup", "pair.js"));
        // The forbidden inline-login surface must not exist (DESIGN §§3,4,12).
        expect(rels).not.toContain(join("popup", "login.js"));
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

    it("shared/session.js is the sole owner of refresh-token storage.session I/O", () => {
        const session = readFileSync(join(ROOT, "shared", "session.js"), "utf8");
        expect(session).toContain("chrome.storage.session.set({ [REFRESH_TOKEN_KEY]: refreshToken })");
        expect(session).toContain("chrome.storage.session.get(REFRESH_TOKEN_KEY)");
        expect(session).toContain("chrome.storage.session.remove(REFRESH_TOKEN_KEY)");
        // The worker must NOT do its own refresh-token storage I/O — it delegates
        // to the single owner, so there is exactly one place secrets are stored.
        const background = readFileSync(join(ROOT, "background.js"), "utf8");
        expect(background).not.toMatch(/chrome\.storage\.session\.\w+/);
    });

    it("shared/pairing.js is the only producer and relays session_established", () => {
        const pairing = readFileSync(join(ROOT, "shared", "pairing.js"), "utf8");
        expect(pairing).toContain('kind: "session_established"');
        // The producer owns no storage — it hands tokens to the worker only.
        expect(pairing).not.toMatch(/chrome\.storage\.(local|session|sync)\.\w+/);
    });

    it("the pairing popup owns no session state and never calls chrome.storage", () => {
        const pair = readFileSync(join(ROOT, "popup", "pair.js"), "utf8");
        // The single ownership boundary is the background worker, so the popup
        // must not invoke any storage API (prose comments are fine; calls not).
        expect(pair).not.toMatch(/chrome\.storage\.(local|session|sync)\.\w+/);
    });
});
