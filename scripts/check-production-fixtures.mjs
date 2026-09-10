import { readFileSync, readdirSync, statSync } from "node:fs";
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
const fixturePath = /(?:^|\/)(?:test\/fixtures|fixtures|__mocks__|mocks)(?:\/|$)/;
const importForms = [
    /\b(?:import|export)\s+(?:(?:[\w*{},\s]+)\s+from\s+)?(["'`])([^"'`]+)\1/g,
    /\b(?:import|require)\s*\(\s*(["'`])([^"'`]+)\1/g,
];
const bad = [];
for (const file of files) {
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    for (const pattern of importForms) {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
            if (fixturePath.test(match[2].replaceAll("\\", "/"))) {
                bad.push(`${relative(root, file)} -> ${match[2]}`);
            }
        }
    }
}
process.stdout.write(`production fixture exclusion — scanned=${files.length} violations=${bad.length}\n`);
for (const violation of bad) process.stdout.write(`  - ${violation}\n`);
if (bad.length) process.exit(1);
process.stdout.write("OK: production modules do not reference test fixtures or mocks\n");
