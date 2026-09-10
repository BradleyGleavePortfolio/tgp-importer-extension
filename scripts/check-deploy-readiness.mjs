import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { constantString, parseSource, visit } from "./lib/js-ast.mjs";

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
const marker = /TODO_BEFORE_PROD|_test_PLACEHOLDER|pk_test_|sk_test_|whsec_test|\b(?:STUB|MOCK|FAKE|PLACEHOLDER)\b|127\.0\.0\.1|https?:\/\/(?:localhost(?=[:/])|(?:[^/\s"']+\.)?example\.com(?=[:/\s"']))/;
const hits = [];
for (const file of files) {
    const source = readFileSync(file, "utf8");
    source.split("\n").forEach((line, index) => {
        if (marker.test(line)) hits.push(`${relative(root, file)}:${index + 1}`);
    });
    if (/\.[cm]?[jt]sx?$/.test(file)) visit(parseSource(source, file), (node) => {
        const text = constantString(node);
        if (text && marker.test(text)) hits.push(`${relative(root, file)}:composed`);
    });
}
let manifest = {};
try { manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")); } catch { manifest = {}; }
const worker = manifest.background?.service_worker;
const workerPath = typeof worker === "string" ? resolve(root, worker) : "";
let workerIsFile = false;
try {
    workerIsFile = workerPath.startsWith(`${root}${sep}`) && [".js", ".mjs", ".cjs"].includes(extname(workerPath)) &&
        statSync(workerPath).isFile();
} catch { workerIsFile = false; }
const checks = [
    ["manifest-v3", manifest.manifest_version === 3],
    ["background-worker-declared", typeof worker === "string" && worker.length > 0],
    ["background-worker-exists", workerIsFile],
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
