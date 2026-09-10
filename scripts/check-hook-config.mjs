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
if (
  manifest.scripts?.["type-check"] !==
  "tsc -p jsconfig.json && tsc -p jsconfig.scripts.json"
)
  missing.push("type-check command");
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
    if ([".git", "node_modules"].includes(item.name)) continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) walk(path);
    else if (/\.(?:js|mjs)$/.test(item.name))
      expected.push(relative(root, path));
  }
}
walk(root);
let listed = [];
try {
  const tsc = "node_modules/typescript/bin/tsc";
  const effective = JSON.parse(
    execFileSync(
      process.execPath,
      [tsc, "-p", "jsconfig.json", "--showConfig"],
      {
        encoding: "utf8",
      },
    ),
  );
  if (
    effective.compilerOptions?.allowJs !== true ||
    effective.compilerOptions?.checkJs !== true ||
    effective.compilerOptions?.noEmit !== true
  )
    missing.push("semantic JavaScript compiler options");
  listed = execFileSync(
    process.execPath,
    [tsc, "-p", "jsconfig.json", "--listFilesOnly"],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/)
    .map((path) => relative(root, path))
    .filter(
      (path) => !path.startsWith("node_modules/") && /\.(?:js|mjs)$/.test(path),
    );
  execFileSync(
    process.execPath,
    [tsc, "-p", "jsconfig.json", "--pretty", "false"],
    {
      encoding: "utf8",
    },
  );
} catch {
  missing.push("semantic type-check execution");
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
  `OK: pinned pre-commit hook semantically checks the effective ${expected.length}-file production/test/scripts set and formatting\n`,
);
