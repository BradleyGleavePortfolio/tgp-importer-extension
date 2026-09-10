import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { constantString, parseSource, ts, visit } from "./lib/js-ast.mjs";

const root = resolve(process.argv[2] ?? ".");
const excluded = new Set([
  ".git",
  ".github",
  "docs",
  "node_modules",
  "scripts",
  "test",
]);
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (excluded.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(?:[cm]?[jt]sx?|json|html)$/.test(name)) files.push(path);
  }
}
walk(root);
const fixturePath =
  /(?:^|\/)(?:test\/fixtures|fixtures|__mocks__|mocks)(?:\/|$)/;
const bad = [];
for (const file of files) {
  visit(parseSource(readFileSync(file, "utf8"), file), (node) => {
    let expression =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : null;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    )
      expression = node.arguments[0];
    const path = expression && constantString(expression);
    if (path && fixturePath.test(path.replaceAll("\\", "/")))
      bad.push(`${relative(root, file)} -> ${path}`);
  });
}
process.stdout.write(
  `production fixture exclusion — scanned=${files.length} violations=${bad.length}\n`,
);
for (const violation of bad) process.stdout.write(`  - ${violation}\n`);
if (bad.length) process.exit(1);
process.stdout.write(
  "OK: production modules do not reference test fixtures or mocks\n",
);
