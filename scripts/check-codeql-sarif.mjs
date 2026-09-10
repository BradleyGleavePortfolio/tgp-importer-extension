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

let findings = 0;
const details = [];
try {
    walk(root);
    if (files.length === 0) throw new Error("CodeQL produced no SARIF result");
    for (const file of files) {
        const sarif = JSON.parse(readFileSync(file, "utf8"));
        if (!sarif || !Array.isArray(sarif.runs)) throw new Error(`${file}: runs must be an array`);
        for (const [runIndex, run] of sarif.runs.entries()) {
            if (!run || (run.results !== undefined && !Array.isArray(run.results))) {
                throw new Error(`${file}: run ${runIndex} results must be an array`);
            }
            for (const result of run.results ?? []) {
                findings += 1;
                const physical = result?.locations?.[0]?.physicalLocation;
                const location = physical?.artifactLocation?.uri ?? "<no-file>";
                const line = physical?.region?.startLine ?? "?";
                const message = result?.message?.text ?? "<no-message>";
                details.push(`${result?.ruleId ?? "<no-rule>"} level=${result?.level ?? "default"} ${location}:${line} ${message}`);
            }
        }
    }
} catch (error) {
    process.stdout.write(`FAIL: invalid CodeQL SARIF: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exit(1);
}
process.stdout.write(`CodeQL SARIF gate — files=${files.length} findings=${findings}\n`);
for (const detail of details) process.stdout.write(`  - ${detail}\n`);
if (findings > 0) process.exit(1);
process.stdout.write("OK: CodeQL analysis has zero results\n");
