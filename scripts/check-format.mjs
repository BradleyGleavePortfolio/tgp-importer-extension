import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { format, getFileInfo } from "prettier";
import { mergeBase, resolveBase } from "./lib/git-diff.mjs";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const eligible = tracked.filter(
  (path) =>
    /^(?:[^/]+\.js|(?:content|extractors|popup|shared|test)\/.*\.js|scripts\/.*\.mjs)$/.test(
      path,
    ) || ["package.json", "jsconfig.json", "lefthook.yml"].includes(path),
);
const unresolved = [];
for (const path of eligible) {
  const info = await getFileInfo(path, { ignorePath: ".prettierignore" });
  if (info.ignored || info.inferredParser === null) unresolved.push(path);
}
if (unresolved.length) {
  process.stdout.write(
    `FAIL: Prettier effective scope omits: ${unresolved.join(", ")}\n`,
  );
  process.exit(1);
}
if (process.argv.includes("--scope")) {
  process.stdout.write(
    `Prettier effective scope covers ${eligible.length} tracked source/test/config files\n`,
  );
  process.exit(0);
}
const from = mergeBase(resolveBase());
const changed = new Set(
  [
    execFileSync("git", ["diff", "--name-only", "-z", from, "HEAD"], {
      encoding: "utf8",
    }),
    execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
      encoding: "utf8",
    }),
  ]
    .join("")
    .split("\0")
    .filter(Boolean),
);
const files = eligible.filter((path) => changed.has(path));
const failures = [];
for (const path of files) {
  const source = readFileSync(path, "utf8");
  if (source !== (await format(source, { filepath: path })))
    failures.push(path);
}
if (failures.length) {
  process.stdout.write(
    `FAIL: files are not canonically formatted:\n  - ${failures.join("\n  - ")}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `OK: Prettier checked ${files.length} tracked files with no ignored or unformatted file\n`,
);
