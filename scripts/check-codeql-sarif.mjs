import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "codeql-results";
const files = [];
function walk(dir) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".sarif")) files.push(path);
    }
}
walk(root);
if (files.length === 0) {
    process.stdout.write("FAIL: CodeQL produced no SARIF result\n");
    process.exit(1);
}
let findings = 0;
for (const file of files) {
    const sarif = JSON.parse(readFileSync(file, "utf8"));
    for (const run of sarif.runs ?? []) {
        findings += (run.results ?? []).filter((result) =>
            result.level === "error" || result.level === "warning").length;
    }
}
process.stdout.write(`CodeQL SARIF gate — files=${files.length} blocking_findings=${findings}\n`);
if (findings > 0) process.exit(1);
process.stdout.write("OK: CodeQL analysis has no blocking findings\n");
