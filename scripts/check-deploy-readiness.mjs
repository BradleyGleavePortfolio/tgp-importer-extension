import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const excluded = new Set([".git", ".github", "docs", "node_modules", "scripts", "test"]);
const files = [];
function walk(dir) {
    for (const name of readdirSync(dir)) {
        if (excluded.has(name)) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:js|mjs|cjs|json|html)$/.test(name)) files.push(path);
    }
}
walk(root);
const marker = /TODO_BEFORE_PROD|_test_PLACEHOLDER|pk_test_|sk_test_|whsec_test|\bSTUB\b|https?:\/\/(?:localhost(?=[:/])|(?:[^/\s"']+\.)?example\.com(?=[:/\s"']))/;
const hits = [];
for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (marker.test(line)) hits.push(`${relative(root, file)}:${index + 1}`);
    });
}
let manifest = {};
try { manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")); } catch { /* failed check below */ }
const worker = manifest.background?.service_worker;
const checks = [
    ["manifest-v3", manifest.manifest_version === 3],
    ["background-worker-declared", typeof worker === "string" && worker.length > 0],
    ["background-worker-exists", typeof worker === "string" && existsSync(join(root, worker))],
    ["version-format", /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")],
    ["forbidden-production-markers", hits.length === 0],
];
process.stdout.write("PRODUCTION STATIC PREFLIGHT (manifest, entrypoint, markers only)\n");
for (const [name, pass] of checks) process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}\n`);
for (const hit of hits) process.stdout.write(`  - ${hit}\n`);
if (checks.some(([, pass]) => !pass)) {
    process.stdout.write("EXIT: PREFLIGHT GAPS\n");
    process.exit(1);
}
process.stdout.write("EXIT: STATIC PREFLIGHT CHECKS CLEAR\n");
