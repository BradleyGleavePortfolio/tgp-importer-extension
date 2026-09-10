// Banned-token net — two mechanical checks that must both pass.
//
// 1. SOURCE PATTERNS: canonical R75 net-new escape hatches, silent catches,
//    unjustified TypeScript suppressions, and placeholder copy are forbidden.
// 2. COMMIT IDENTITY (R3): every commit this branch adds must be authored AND
//    committed as Bradley Gleave <bradley@bradleytgpcoaching.com>, with no
//    AI/agent/co-author tokens anywhere in author, committer, or message.
//
// Usage: node scripts/check-banned.mjs
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveBase, mergeBase } from "./lib/git-diff.mjs";
import { bannedCounts } from "./lib/js-ast.mjs";

const failures = [];

// ---- 1. canonical R75 diff-scoped source patterns -----------------------------

const base = resolveBase();
const from = mergeBase(base);
const range = process.env.BANNED_DIFF_CACHED === "1" ? "--cached" : `${from} HEAD`;
const patch = execSync(
    `git diff --unified=0 ${range} -- '*.js' '*.mjs' '*.ts' '*.tsx' '*.jsx' ` +
    `':(exclude)scripts/check-banned.mjs'`,
    { encoding: "utf8" },
);
const added = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
const removed = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
const counts = (lines) => bannedCounts(lines.map((line) => line.slice(1)).join("\n"));
const addedCounts = counts(added), removedCounts = counts(removed);
for (const [label, count] of addedCounts)
    if (count > (removedCounts.get(label) ?? 0)) failures.push(`R75 net-new banned token: ${label}`);
for (const line of added) {
    const marker = line.indexOf("@ts-expect-error");
    if (marker >= 0 && !/^\s+\S.{2,}$/.test(line.slice(marker + 16))) {
        failures.push("R75 @ts-expect-error requires a current reason on the same line");
    }
}
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || /[~^*]|\s|\|\|/.test(version)) {
        failures.push(`R114 dependency ${name} is not pinned exactly: ${version}`);
    }
    if (/^0\./.test(version) && !(typeof manifest.dependencyPolicyExceptions?.[name] === "string" &&
        manifest.dependencyPolicyExceptions[name].length >= 20))
        failures.push(`R33 dependency ${name} uses 0.x without a documented exception`);
}
for (const name of Object.keys(manifest.dependencyPolicyExceptions ?? {}))
    if (!Object.hasOwn(dependencies, name)) failures.push(`R33 stale dependency exception: ${name}`);

// ---- 2. commit identity (R3) ------------------------------------------------

const EXPECTED_NAME = "Bradley Gleave";
const EXPECTED_EMAIL = "bradley@bradleytgpcoaching.com";
const IDENTITY_TOKENS = /(claude|anthropic|co-authored-by|copilot|openai|\bgpt\b|assistant|dynasia|noreply@)/i;

const raw = process.env.BANNED_DIFF_CACHED === "1" ? "" : execSync(
    `git log ${from}..HEAD --format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e`,
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
