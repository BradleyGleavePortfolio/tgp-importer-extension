import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";

let config = {};
try {
  config = parse(readFileSync("lefthook.yml", "utf8"));
} catch {
  config = {};
}
let manifest = {};
try {
  manifest = JSON.parse(readFileSync("package.json", "utf8"));
} catch {
  manifest = {};
}
const required = {
  banned: "BANNED_DIFF_CACHED=1 npm run check:banned",
  "deploy-readiness": "npm run check:production-preflight",
  lint: "npm run lint",
  "type-check": "npm run type-check",
  format: "npm run format:check",
};
const commands = config?.["pre-commit"]?.commands;
const missing = Object.entries(required)
  .filter(([name, run]) => !commands || commands[name]?.run !== run)
  .map(([name]) => name);
if (config?.min_version !== "2.1.12") missing.unshift("min_version");
if (manifest.scripts?.["format:check"] !== "node scripts/check-format.mjs")
  missing.push("format command");
try {
  execFileSync(process.execPath, ["scripts/check-format.mjs", "--scope"], {
    encoding: "utf8",
  });
} catch {
  missing.push("format effective scope");
}
const root = resolve("."),
  expected = [];
function walk(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "scripts", "test"].includes(item.name))
      continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) walk(path);
    else if (item.name.endsWith(".js")) expected.push(relative(root, path));
  }
}
walk(root);
let listed = [];
try {
  listed = execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-p",
      "jsconfig.json",
      "--listFilesOnly",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/)
    .map((path) => relative(root, path))
    .filter(
      (path) => !path.startsWith("node_modules/") && path.endsWith(".js"),
    );
} catch {
  missing.push("type-check execution");
}
for (const path of expected)
  if (!listed.includes(path)) missing.push(`type-check scope ${path}`);
if (missing.length) {
  process.stdout.write(
    `FAIL: pre-commit hook missing/alignment error: ${missing.join(", ")}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `OK: pinned pre-commit hook covers ${expected.length} production JS files and source/test formatting\n`,
);
