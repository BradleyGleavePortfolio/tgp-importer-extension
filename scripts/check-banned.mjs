// Banned-token net — two mechanical checks that must both pass.
//
// 1. SOURCE PATTERNS: production JS may not silently swallow a failure. The
//    banned forms are `.catch(() => null)` / `.catch(()=>null)` and an empty
//    `catch {}` block — both discard an error with no mapping and no log. The
//    allowed alternative is an explicit catch that maps to a typed result and
//    logs a PII-free event (shared/log.js). Note: `.catch(() => undefined)` on a
//    best-effort UI broadcast is NOT banned — a closed popup is a normal,
//    non-actionable outcome.
// 2. COMMIT IDENTITY (R3): every commit this branch adds must be authored AND
//    committed as Bradley Gleave <bradley@bradleytgpcoaching.com>, with no
//    AI/agent/co-author tokens anywhere in author, committer, or message.
//
// Usage: node scripts/check-banned.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolveBase, mergeBase } from "./lib/git-diff.mjs";

const failures = [];

// ---- 1. source patterns -----------------------------------------------------

const SILENT_CATCH = /\.catch\(\s*\(\s*\)\s*=>\s*null\s*\)/;
const EMPTY_CATCH = /catch\s*\{\s*\}/;
const SKIP_DIRS = new Set(["node_modules", ".git", "test", "scripts"]);

function prodJsFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...prodJsFiles(full));
        else if (name.endsWith(".js")) out.push(full);
    }
    return out;
}

for (const file of prodJsFiles(".")) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
        if (SILENT_CATCH.test(line)) failures.push(`${file}:${i + 1} banned silent .catch(() => null)`);
        if (EMPTY_CATCH.test(line)) failures.push(`${file}:${i + 1} banned empty catch {}`);
    });
}

// ---- 2. commit identity (R3) ------------------------------------------------

const EXPECTED_NAME = "Bradley Gleave";
const EXPECTED_EMAIL = "bradley@bradleytgpcoaching.com";
const IDENTITY_TOKENS = /(claude|anthropic|co-authored-by|copilot|openai|\bgpt\b|assistant|dynasia|noreply@)/i;

const base = resolveBase();
const from = mergeBase(base);
// --no-merges: pull_request CI checks out a synthetic merge commit authored by
// GitHub <noreply@github.com>. That is not a PR commit and must not trip R3.
const raw = execSync(
    `git log ${from}..HEAD --no-merges --format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e`,
    { encoding: "utf8" },
);
for (const rec of raw.split("\x1e")) {
    const trimmed = rec.trim();
    if (!trimmed) continue;
    const [sha, an, ae, cn, ce, body] = trimmed.split("\x1f");
    const short = sha.slice(0, 8);
    if (an !== EXPECTED_NAME || ae !== EXPECTED_EMAIL) failures.push(`${short} author is "${an} <${ae}>", expected "${EXPECTED_NAME} <${EXPECTED_EMAIL}>"`);
    if (cn !== EXPECTED_NAME || ce !== EXPECTED_EMAIL) failures.push(`${short} committer is "${cn} <${ce}>", expected "${EXPECTED_NAME} <${EXPECTED_EMAIL}>"`);
    if (IDENTITY_TOKENS.test(body)) failures.push(`${short} commit message contains a banned AI/agent/co-author token`);
}

// ---- verdict ----------------------------------------------------------------

if (failures.length > 0) {
    process.stdout.write("FAIL: banned-token net\n");
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
}
process.stdout.write(`OK: banned-token net clean (source patterns + ${base} commit identity)\n`);
