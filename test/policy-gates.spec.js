import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const made = [];
function temp() {
    const dir = mkdtempSync(join(tmpdir(), "importer-gate-"));
    made.push(dir);
    return dir;
}
function put(root, path, content) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}
function run(script, root) {
    return spawnSync(process.execPath, [join(repo, "scripts", script), root], { encoding: "utf8" });
}
function sarif(runs) {
    return JSON.stringify({ version: "2.1.0", runs });
}
afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("CodeQL SARIF zero-result gate", () => {
    it("accepts valid empty runs", () => {
        const root = temp();
        put(root, "clean.sarif", sarif([{ results: [] }, {}]));
        const result = run("check-codeql-sarif.mjs", root);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("findings=0");
    });

    it.each(["error", "warning", "note", undefined])("rejects a %s-level result", (level) => {
        const root = temp();
        const result = { ruleId: "js/test" };
        if (level !== undefined) result.level = level;
        put(root, "finding.sarif", sarif([{ results: [result] }]));
        const output = run("check-codeql-sarif.mjs", root);
        expect(output.status).toBe(1);
        expect(output.stdout).toContain(level ?? "default");
    });

    it("rejects suppressed results because no documented exception exists", () => {
        const root = temp();
        put(root, "suppressed.sarif", sarif([{ results: [{
            ruleId: "js/test", suppressions: [{ kind: "inSource", status: "accepted" }],
        }] }]));
        expect(run("check-codeql-sarif.mjs", root).status).toBe(1);
    });

    it("counts every result across multiple runs and files", () => {
        const root = temp();
        put(root, "a.sarif", sarif([{ results: [{ ruleId: "a" }] }, { results: [{ ruleId: "b" }] }]));
        put(root, "nested/b.sarif", sarif([{ results: [{ ruleId: "c" }] }]));
        const output = run("check-codeql-sarif.mjs", root);
        expect(output.status).toBe(1);
        expect(output.stdout).toContain("files=2 findings=3");
    });

    it.each(["{", JSON.stringify({}), sarif([{ results: {} }])])("rejects malformed SARIF", (body) => {
        const root = temp();
        put(root, "bad.sarif", body);
        expect(run("check-codeql-sarif.mjs", root).status).toBe(1);
    });
});

describe("production fixture import preflight", () => {
    it.each([
        'import "./test/fixtures/customer.json";',
        'import value from "./fixtures/customer.js";',
        'import("./__mocks__/customer.js");',
        'const value = require("./mocks/customer.js");',
        'import {\n value\n} from "./test/fixtures/customer.js";',
    ])("rejects production reference: %s", (source) => {
        const root = temp();
        put(root, "background.js", source);
        expect(run("check-production-fixtures.mjs", root).status).toBe(1);
    });

    it("accepts ordinary production imports", () => {
        const root = temp();
        put(root, "background.js", 'import value from "./shared/value.js";');
        expect(run("check-production-fixtures.mjs", root).status).toBe(0);
    });
});

describe("production static preflight", () => {
    function project(source = "export {};", manifest = {}) {
        const root = temp();
        put(root, "background.js", source);
        put(root, "manifest.json", JSON.stringify({
            manifest_version: 3, version: "1.2.3", background: { service_worker: "background.js" }, ...manifest,
        }));
        return root;
    }

    it.each([
        "const state = 'STUB';", "fetch('http://localhost:3000/api');",
        "fetch('https://example.com/api');", "const key = 'pk_test_123';",
    ])("rejects forbidden marker %s", (source) => {
        expect(run("check-deploy-readiness.mjs", project(source)).status).toBe(1);
    });

    it("accepts defensive localhost text but reports only a static preflight", () => {
        const output = run("check-deploy-readiness.mjs", project('if (host === "localhost") throw Error("unsafe");'));
        expect(output.status).toBe(0);
        expect(output.stdout).toContain("STATIC PREFLIGHT");
        expect(output.stdout).not.toContain("DEPLOY READINESS");
    });

    it("rejects an unwired or missing background entrypoint", () => {
        expect(run("check-deploy-readiness.mjs", project("", { background: {} })).status).toBe(1);
        expect(run("check-deploy-readiness.mjs", project("", {
            background: { service_worker: "missing.js" },
        })).status).toBe(1);
    });
});
