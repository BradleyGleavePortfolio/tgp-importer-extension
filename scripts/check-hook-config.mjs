import { readFileSync } from "node:fs";
import { parse } from "yaml";

let config = {};
try { config = parse(readFileSync("lefthook.yml", "utf8")); } catch { config = {}; }
const required = {
    banned: "BANNED_DIFF_CACHED=1 npm run check:banned",
    "deploy-readiness": "npm run check:production-preflight",
    lint: "npm run lint",
    "type-check": "npm run type-check",
    format: "npm run format:check",
};
const commands = config?.["pre-commit"]?.commands;
const missing = Object.entries(required).filter(([name, run]) =>
    !commands || commands[name]?.run !== run).map(([name]) => name);
if (config?.min_version !== "2.1.12") missing.unshift("min_version");
if (missing.length) {
    process.stdout.write(`FAIL: pre-commit hook missing/alignment error: ${missing.join(", ")}\n`);
    process.exit(1);
}
process.stdout.write("OK: pinned pre-commit hook is aligned with required local gates\n");
