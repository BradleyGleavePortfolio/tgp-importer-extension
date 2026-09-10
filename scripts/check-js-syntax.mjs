import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const excluded = new Set([".git", "node_modules"]);
const files = [];
function walk(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (excluded.has(item.name)) continue;
        const path = join(dir, item.name);
        if (item.isDirectory()) walk(path);
        else if (/\.(?:js|mjs|cjs)$/.test(item.name)) files.push(path);
    }
}
walk(".");
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
process.stdout.write(`OK: JavaScript syntax lint passed (${files.length} files)\n`);
