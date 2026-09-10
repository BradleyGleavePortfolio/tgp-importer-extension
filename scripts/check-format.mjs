import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { format, getFileInfo } from "prettier";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const files = tracked.filter(
  (path) =>
    /^(?:[^/]+\.js|(?:content|extractors|popup|shared|test)\/.*\.js|scripts\/.*\.mjs)$/.test(
      path,
    ) || ["package.json", "jsconfig.json", "lefthook.yml"].includes(path),
);
const unresolved = [];
for (const path of files) {
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
    `Prettier effective scope covers ${files.length} tracked source/test/config files\n`,
  );
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(".prettier-baseline.json", "utf8"));
function debt(left, right) {
  const a = left.split(/\r?\n/),
    b = right.split(/\r?\n/);
  let previous = new Uint16Array(b.length + 1);
  for (const line of a) {
    const current = new Uint16Array(b.length + 1);
    for (let index = 1; index <= b.length; index += 1)
      current[index] =
        line === b[index - 1]
          ? previous[index - 1] + 1
          : Math.max(previous[index], current[index - 1]);
    previous = current;
  }
  return a.length + b.length - 2 * previous[b.length];
}
const failures = [];
for (const path of files) {
  const source = readFileSync(path, "utf8");
  const score = debt(source, await format(source, { filepath: path }));
  if (score > (baseline[path] ?? 0))
    failures.push(`${path} debt=${score} baseline=${baseline[path] ?? 0}`);
}
if (failures.length) {
  process.stdout.write(
    `FAIL: Prettier debt increased:\n  - ${failures.join("\n  - ")}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `OK: Prettier checked ${files.length} tracked files with no ignored or increased-debt file\n`,
);
