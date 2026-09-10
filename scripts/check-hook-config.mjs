import { readFileSync } from "node:fs";

let source = "";
try { source = readFileSync("lefthook.yml", "utf8"); } catch { /* reported below */ }
const required = [
    "min_version: 2.1.12",
    "BANNED_DIFF_CACHED=1 npm run check:banned",
    "npm run check:production-preflight",
    "npm run lint",
    "npm run type-check",
];
const missing = required.filter((text) => !source.includes(text));
if (missing.length) {
    process.stdout.write(`FAIL: pre-commit hook missing/alignment error: ${missing.join(", ")}\n`);
    process.exit(1);
}
process.stdout.write("OK: pinned pre-commit hook is aligned with required local gates\n");
