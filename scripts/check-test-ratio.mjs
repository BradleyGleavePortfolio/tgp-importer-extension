// R74 test-density gate — DIFF-SCOPED and non-omittable.
//
// The prior version measured a hardcoded list of three capture files, so any
// new production source (the entire session/pairing/router surface this branch
// adds) was invisible to the gate and could ship untested. This version counts
// every added line of production JS in the PR diff (`<merge-base main..HEAD>`)
// against every added line of test JS, and fails if the ratio drops below the
// floor. A new source file cannot be omitted: it is picked up by the diff walk,
// not a maintained allowlist. Whole-repo scope is not used because the v0.2
// extractor code predates this gate and is out of this branch's scope; the
// honest, enforceable unit is "what this PR adds."
//
// Usage: node scripts/check-test-ratio.mjs
import { resolveBase, diffLineStats } from "./lib/git-diff.mjs";

const FLOOR = 2.0;

const base = resolveBase();
const { prod, test } = diffLineStats(base);
const prodAdded = prod.added;
const testAdded = test.added;
const ratio = prodAdded === 0 ? Infinity : testAdded / prodAdded;

process.stdout.write(
    `test:src diff density (base=${base}) — prod_added=${prodAdded} test_added=${testAdded} ` +
    `ratio=${prodAdded === 0 ? "n/a" : ratio.toFixed(3)} floor=${FLOOR}\n`,
);

if (prodAdded === 0) {
    process.stdout.write("OK: no production JS added in this diff (nothing to gate)\n");
    process.exit(0);
}
if (ratio < FLOOR) {
    process.stdout.write(
        `FAIL: PR diff test:src ${ratio.toFixed(3)} is below the R74 floor of ${FLOOR} ` +
        `(need >= ${Math.ceil(prodAdded * FLOOR)} added test lines for ${prodAdded} added prod lines)\n`,
    );
    process.exit(1);
}
process.stdout.write("OK: PR diff test:src density meets the R74 floor\n");
