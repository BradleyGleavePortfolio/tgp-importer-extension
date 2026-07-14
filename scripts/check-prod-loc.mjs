// Production-LOC gate — diff-scoped, truthful.
//
// Bounds how much production JavaScript a single PR may add. A hyperscaler keeps
// PRs reviewable; unbounded diffs defeat the audit cycle. This counts added
// production JS lines in `<merge-base main..HEAD>` (tests, scripts, and
// node_modules excluded) and fails past the per-PR budget. It reports the real
// number either way, so it never fails silently or dishonestly.
//
// Budget override: PROD_LOC_CAP env var. Usage: node scripts/check-prod-loc.mjs
import { resolveBase, diffLineStats } from "./lib/git-diff.mjs";

const CAP = Number(process.env.PROD_LOC_CAP ?? 600);

const base = resolveBase();
const { prod } = diffLineStats(base);

process.stdout.write(
    `prod LOC (base=${base}) — prod_added=${prod.added} prod_removed=${prod.removed} cap=${CAP}\n`,
);

if (prod.added > CAP) {
    process.stdout.write(`FAIL: added production JS ${prod.added} exceeds the per-PR cap of ${CAP}\n`);
    process.exit(1);
}
process.stdout.write("OK: added production JS is within the per-PR cap\n");
