import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const excluded = new Set([".git", ".github", "docs", "node_modules", "scripts", "test"]);
const files = [];
function walk(dir) {
    for (const name of readdirSync(dir)) {
        if (excluded.has(name)) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:js|json|html)$/.test(name)) files.push(path);
    }
}
walk(".");
const marker = /TODO_BEFORE_PROD|_test_PLACEHOLDER|pk_test_|sk_test_|whsec_test/;
const hits = [];
for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (marker.test(line)) hits.push(`${file}:${index + 1}`);
    });
}
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const checks = [
    ["manifest-v3", manifest.manifest_version === 3],
    ["background-worker", typeof manifest.background?.service_worker === "string"],
    ["version", /^\d+\.\d+\.\d+/.test(manifest.version ?? "")],
    ["production-markers", hits.length === 0],
];
process.stdout.write("DEPLOY READINESS BOARD\n");
checks.forEach(([name, pass]) => process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}\n`));
hits.forEach((hit) => process.stdout.write(`  - ${hit}\n`));
if (checks.some(([, pass]) => !pass)) {
    process.stdout.write("EXIT: READINESS GAPS -> DO NOT DEPLOY\n");
    process.exit(1);
}
process.stdout.write("EXIT: ALL APPLICABLE CHECKS CLEAR\n");
