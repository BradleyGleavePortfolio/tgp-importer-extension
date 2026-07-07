// R74 test-density gate: the capture subsystem must carry a test:src line ratio
// of >= 2.0. Scope is the capture code this branch owns (shared/capture*.js) and
// the tests that exercise it (everything under test/). The audit baseline was
// 1.91; this gate fails CI if density regresses back under the 2.0 floor.
//
// Usage: node scripts/check-test-ratio.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FLOOR = 2.0;

const SRC_FILES = ["shared/capture.js", "shared/capture-buffer.js"];

function lineCount(path) {
    return readFileSync(path, "utf8").split("\n").length;
}

// Recursively collect every .js file under a directory.
function jsFilesUnder(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            out.push(...jsFilesUnder(full));
        }
        else if (name.endsWith(".js")) {
            out.push(full);
        }
    }
    return out;
}

const srcLoc = SRC_FILES.reduce((sum, f) => sum + lineCount(f), 0);
const testLoc = jsFilesUnder("test").reduce((sum, f) => sum + lineCount(f), 0);
const ratio = testLoc / srcLoc;

process.stdout.write(
    `test:src density — test=${testLoc} src=${srcLoc} ratio=${ratio.toFixed(3)} floor=${FLOOR}\n`,
);

if (ratio < FLOOR) {
    process.stdout.write(`FAIL: test:src ${ratio.toFixed(3)} is below the R74 floor of ${FLOOR}\n`);
    process.exit(1);
}
process.stdout.write("OK: test:src density meets the R74 floor\n");
