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
const bad = files.filter((file) =>
    /(?:from\s+|import\s*\()["'][^"']*(?:test\/fixtures|fixtures\/|__mocks__|\/mocks\/)/.test(
        readFileSync(file, "utf8"),
    ));
process.stdout.write(`production fixture exclusion — scanned=${files.length} violations=${bad.length}\n`);
if (bad.length) {
    bad.forEach((file) => process.stdout.write(`  - ${file}\n`));
    process.exit(1);
}
process.stdout.write("OK: no production-bound file imports a test fixture or mock\n");
