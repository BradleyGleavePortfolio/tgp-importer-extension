import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { classify } from "../scripts/lib/git-diff.mjs";

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
  return spawnSync(process.execPath, [join(repo, "scripts", script), root], {
    encoding: "utf8",
  });
}
function sarif(runs) {
  return JSON.stringify({
    version: "2.1.0",
    runs: runs.map((run) => ({
      tool: { driver: { name: "CodeQL" } },
      invocations: [{ executionSuccessful: true }],
      ...run,
    })),
  });
}
afterEach(() =>
  made
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

describe("CodeQL SARIF zero-result gate", () => {
  it("accepts valid empty runs", () => {
    const root = temp();
    put(root, "clean.sarif", sarif([{ results: [] }, { results: [] }]));
    const result = run("check-codeql-sarif.mjs", root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("findings=0");
  });

  it.each(["error", "warning", "note", undefined])(
    "rejects a %s-level result",
    (level) => {
      const root = temp();
      const result = { ruleId: "js/test" };
      if (level !== undefined) result.level = level;
      put(root, "finding.sarif", sarif([{ results: [result] }]));
      const output = run("check-codeql-sarif.mjs", root);
      expect(output.status).toBe(1);
      expect(output.stdout).toContain(level ?? "default");
    },
  );

  it("rejects suppressed results because no documented exception exists", () => {
    const root = temp();
    put(
      root,
      "suppressed.sarif",
      sarif([
        {
          results: [
            {
              ruleId: "js/test",
              suppressions: [{ kind: "inSource", status: "accepted" }],
            },
          ],
        },
      ]),
    );
    expect(run("check-codeql-sarif.mjs", root).status).toBe(1);
  });

  it("counts every result across multiple runs and files", () => {
    const root = temp();
    put(
      root,
      "a.sarif",
      sarif([{ results: [{ ruleId: "a" }] }, { results: [{ ruleId: "b" }] }]),
    );
    put(root, "nested/b.sarif", sarif([{ results: [{ ruleId: "c" }] }]));
    const output = run("check-codeql-sarif.mjs", root);
    expect(output.status).toBe(1);
    expect(output.stdout).toContain("files=2 findings=3");
  });

  it.each(["{", JSON.stringify({}), sarif([{ results: {} }])])(
    "rejects malformed SARIF",
    (body) => {
      const root = temp();
      put(root, "bad.sarif", body);
      expect(run("check-codeql-sarif.mjs", root).status).toBe(1);
    },
  );

  it.each([
    JSON.stringify({ version: "2.1.0", runs: [] }),
    JSON.stringify({ version: "2.1.0", runs: [42] }),
    JSON.stringify({ version: "2.1.0", runs: ["bad"] }),
    JSON.stringify({ version: "2.1.0", runs: [{ results: [] }] }),
    sarif([{ invocations: [], results: [] }]),
    sarif([{ invocations: [{ executionSuccessful: false }], results: [] }]),
    sarif([{ invocations: [{}], results: [] }]),
    sarif([{ invocations: [{ executionSuccessful: "false" }], results: [] }]),
    sarif([
      { tool: { driver: { name: "Definitely Not CodeQL" } }, results: [] },
    ]),
  ])("rejects incomplete or failed CodeQL run structure", (body) => {
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
    "const value = require(`./fixtures/customer.js`);",
    'import(`./fixtures/customer.js`, { with: { type: "json" } });',
    'import/* keep */"./mocks/customer.js";',
    'const value = require (/* keep */ "./mocks/customer.js");',
    'import value from "./fixtures/customer.json" with { type: "json" };',
    'import("./test/fixt\\u0075res/customer.js");',
    'import("./test/" + "fixtures/customer.js");',
    'import(`./${"fixtures"}/customer.js`);',
    'import(`./test/${"fixtures"}/customer.js`);',
    'const p = "./fixtures/customer.js"; import(p);',
    "import(String.raw`./fixtures/customer.js`);",
    'import(String.raw`./test/fixt${"ures"}/customer.js`);',
    'import(String.raw`./test/${`fixt${"ures"}`}/customer.js`);',
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

  it("resolves shadowed const fixture paths in their lexical functions", () => {
    const root = temp();
    put(
      root,
      "background.js",
      [
        'function clean() { const path = "./shared/value.js"; import(path); }',
        'function unsafe() { const path = "./test/fixtures/customer.js"; import(path); }',
      ].join("\n"),
    );
    const output = run("check-production-fixtures.mjs", root);
    expect(output.status).toBe(1);
    expect(output.stdout).toContain("./test/fixtures/customer.js");
  });
});

describe("production static preflight", () => {
  function project(source = "export {};", manifest = {}) {
    const root = temp();
    put(root, "background.js", source);
    put(
      root,
      "manifest.json",
      JSON.stringify({
        manifest_version: 3,
        version: "1.2.3",
        background: { service_worker: "background.js" },
        ...manifest,
      }),
    );
    return root;
  }

  it.each([
    "const state = 'STUB';",
    "fetch('http://localhost:3000/api');",
    "fetch('https://example.com/api');",
    "const key = 'pk_test_123';",
    "const state = 'MOCK';",
    "const state = 'FAKE';",
    "const state = 'PLACEHOLDER';",
    "fetch('http://127.0.0.1:8080/api');",
    'const state = "MO" + "CK";',
    'const host = "http://127.0.0." + "1:8080";',
    "const state = ['M','O','C','K'].join('');",
    'const state = `M${"O"}CK`;',
    'const state = `MO${"CK"}`;',
    'const state = "\\u004dOCK";',
    'const left = "MO"; const state = left + "CK";',
    "const state = String.fromCharCode(77, 79, 67, 75);",
    'const state = ["m", "o", "c", "k"].map((x) => x.toUpperCase()).join("");',
    'const state = ["M", ...["O", "C"], "K"].join("");',
  ])("rejects forbidden marker %s", (source) => {
    expect(run("check-deploy-readiness.mjs", project(source)).status).toBe(1);
  });

  it("accepts defensive localhost text but reports only a static preflight", () => {
    const output = run(
      "check-deploy-readiness.mjs",
      project('if (host === "localhost") throw Error("unsafe");'),
    );
    expect(output.status).toBe(0);
    expect(output.stdout).toContain("STATIC PREFLIGHT");
    expect(output.stdout).not.toContain("DEPLOY READINESS");
  });

  it("rejects an unwired or missing background entrypoint", () => {
    expect(
      run("check-deploy-readiness.mjs", project("", { background: {} })).status,
    ).toBe(1);
    expect(
      run(
        "check-deploy-readiness.mjs",
        project("", {
          background: { service_worker: "missing.js" },
        }),
      ).status,
    ).toBe(1);
    expect(
      run(
        "check-deploy-readiness.mjs",
        project("", {
          background: { service_worker: "." },
        }),
      ).status,
    ).toBe(1);
    expect(
      run(
        "check-deploy-readiness.mjs",
        project("", {
          background: { service_worker: "manifest.json" },
        }),
      ).status,
    ).toBe(1);
  });

  it("resolves shadowed composed markers in their lexical functions", () => {
    const source = [
      'function clean() { const left = "RE"; return left + "AL"; }',
      'function unsafe() { const left = "MO"; return left + "CK"; }',
    ].join("\n");
    const output = run("check-deploy-readiness.mjs", project(source));
    expect(output.status).toBe(1);
    expect(output.stdout).toContain("forbidden-production-markers");
  });
});

describe("canonical diff classification", () => {
  it.each([
    ["src/main.js", "prod"],
    ["src/view.jsx", "prod"],
    ["src/types.ts", "prod"],
    ["src/view.tsx", "prod"],
    ["test/unit.js", "test"],
    ["src/__tests__/unit.ts", "test"],
    ["src/unit.spec.jsx", "test"],
    ["src/unit.test.tsx", "test"],
  ])("classifies %s as %s", (path, category) =>
    expect(classify(path)).toBe(category),
  );
});

describe("banned-token gate source coverage", () => {
  function mutation(path, source, baseSource) {
    const root = temp();
    put(root, "package.json", JSON.stringify({ private: true }));
    put(root, "base.txt", "base");
    if (baseSource !== undefined) put(root, path, baseSource);
    for (const args of [["init"], ["add", "."], ["commit", "-m", "base"]]) {
      const output = spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Bradley Gleave",
          GIT_AUTHOR_EMAIL: "bradley@bradleytgpcoaching.com",
          GIT_COMMITTER_NAME: "Bradley Gleave",
          GIT_COMMITTER_EMAIL: "bradley@bradleytgpcoaching.com",
        },
      });
      expect(output.status).toBe(0);
    }
    put(root, path, source);
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-m", "mutation"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Bradley Gleave",
        GIT_AUTHOR_EMAIL: "bradley@bradleytgpcoaching.com",
        GIT_COMMITTER_NAME: "Bradley Gleave",
        GIT_COMMITTER_EMAIL: "bradley@bradleytgpcoaching.com",
      },
    });
    return spawnSync(
      process.execPath,
      [join(repo, "scripts/check-banned.mjs")],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, RATIO_BASE: "HEAD~1" },
      },
    );
  }

  it.each([
    ["test/r75-mutant.ts", `const value = thing ${"as " + "any"};`],
    ["src/type-assertion.ts", "const value = <any>thing;"],
    ["src/r75-mutant.jsx", `Promise.resolve().catch(() => ${"undefined"});`],
    ["src/multiline.ts", "const value = thing as" + "\n" + "any;"],
    ["src/comment.ts", "const value = thing as /" + "* comment */ any;"],
    ["src/catch.ts", "Promise.resolve().catch(\n () => " + "undefined,\n);"],
    [
      "src/catch-comment.ts",
      "Promise.resolve().catch(() => { /" + "* empty */ });",
    ],
    [
      "src/url.ts",
      'declare const thing: unknown; const url = "https://safe.invalid"; const value = thing as any;',
    ],
    [
      "src/string-comment.ts",
      'declare const thing: unknown; const marker = "//"; const value = thing as any;',
    ],
    [
      "src/string-block.ts",
      'declare const thing: unknown; const open = "/*"; const value = thing as any; const close = "*/";',
    ],
    [
      "src/regex.ts",
      "declare const thing: unknown; const pattern = /https?:\\/\\/safe/; const value = thing as any;",
    ],
    ["src/function.ts", "Promise.resolve().catch(function () {});"],
    ["src/empty-statement.ts", "Promise.resolve().catch(() => { ; });"],
    ["src/parenthesized.ts", "Promise.resolve().catch(() => (undefined));"],
    ["src/void.ts", "Promise.resolve().catch(() => void 0);"],
  ])("rejects a banned addition in %s", (path, source) => {
    const output = mutation(path, source);
    expect(output.status).toBe(1);
    expect(output.stdout).toContain("R75 net-new banned token");
  });

  it("does not mistake banned-looking string contents for executable syntax", () => {
    expect(
      mutation(
        "src/safe.ts",
        'export const documentation = "use as any only in prose";',
      ).status,
    ).toBe(0);
  });

  it("parses a changed line together with unchanged multiline context", () => {
    const before =
      "declare const thing: unknown;\nconst value = thing as\nstring;\n";
    const after =
      "declare const thing: unknown;\nconst value = thing as\nany;\n";
    const output = mutation("src/context.ts", after, before);
    expect(output.status).toBe(1);
    expect(output.stdout).toContain("as any");
  });

  it("does not let a same-file removal mask an unrelated banned addition", () => {
    const before = [
      "declare const one: unknown;",
      "function removed() { return one as any; }",
    ].join("\n");
    const after = [
      "declare const two: unknown;",
      "function added() { return two as any; }",
    ].join("\n");
    const output = mutation("src/swap.ts", after, before);
    expect(output.status).toBe(1);
    expect(output.stdout).toContain("added");
  });

  it("preserves grandfathered findings across a pure rename", () => {
    const root = temp();
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Bradley Gleave",
      GIT_AUTHOR_EMAIL: "bradley@bradleytgpcoaching.com",
      GIT_COMMITTER_NAME: "Bradley Gleave",
      GIT_COMMITTER_EMAIL: "bradley@bradleytgpcoaching.com",
    };
    put(root, "package.json", JSON.stringify({ private: true }));
    put(root, "src/old.ts", "declare const value: unknown;\nvalue as any;\n");
    for (const args of [["init"], ["add", "."], ["commit", "-m", "base"]])
      expect(spawnSync("git", args, { cwd: root, env }).status).toBe(0);
    expect(
      spawnSync("git", ["mv", "src/old.ts", "src/new.ts"], {
        cwd: root,
        env,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["commit", "-m", "rename"], { cwd: root, env }).status,
    ).toBe(0);
    const output = spawnSync(
      process.execPath,
      [join(repo, "scripts/check-banned.mjs")],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...env, RATIO_BASE: "HEAD~1" },
      },
    );
    expect(output.status).toBe(0);
  });

  it.each([
    "evil$(touch PWNED).ts",
    "evil`touch PWNED`.ts",
    'evil"quote.ts',
    "evil'quote.ts",
    "evil\nnewline.ts",
    "-leading-dash.ts",
    "evil;&|<>.ts",
  ])("treats the hostile filename %j only as data", (name) => {
    const root = temp();
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Bradley Gleave",
      GIT_AUTHOR_EMAIL: "bradley@bradleytgpcoaching.com",
      GIT_COMMITTER_NAME: "Bradley Gleave",
      GIT_COMMITTER_EMAIL: "bradley@bradleytgpcoaching.com",
    };
    put(root, "package.json", JSON.stringify({ private: true }));
    put(root, "base.txt", "base");
    for (const args of [["init"], ["add", "."], ["commit", "-m", "base"]])
      expect(spawnSync("git", args, { cwd: root, env }).status).toBe(0);
    put(
      root,
      join("src", name),
      "declare const value: unknown;\nvalue as any;\n",
    );
    expect(spawnSync("git", ["add", "."], { cwd: root, env }).status).toBe(0);
    expect(
      spawnSync("git", ["commit", "-m", "hostile path"], {
        cwd: root,
        env,
      }).status,
    ).toBe(0);
    const output = spawnSync(
      process.execPath,
      [join(repo, "scripts/check-banned.mjs")],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...env, RATIO_BASE: "HEAD~1" },
      },
    );
    expect(output.status).toBe(1);
    expect(output.stdout).toContain("R75 net-new banned token");
    expect(existsSync(join(root, "PWNED"))).toBe(false);
  });

  it("checks merge-commit author and committer identity", () => {
    const root = temp(),
      good = {
        ...process.env,
        GIT_AUTHOR_NAME: "Bradley Gleave",
        GIT_AUTHOR_EMAIL: "bradley@bradleytgpcoaching.com",
        GIT_COMMITTER_NAME: "Bradley Gleave",
        GIT_COMMITTER_EMAIL: "bradley@bradleytgpcoaching.com",
      };
    const git = (args, env = good) =>
      spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    put(root, "package.json", JSON.stringify({ private: true }));
    expect(git(["init"]).status).toBe(0);
    expect(git(["add", "."]).status).toBe(0);
    expect(git(["commit", "-m", "base"]).status).toBe(0);
    const base = git(["rev-parse", "HEAD"]).stdout.trim();
    expect(git(["checkout", "-b", "topic"]).status).toBe(0);
    put(root, "src/value.js", "export const value = 1;\n");
    expect(git(["add", "."]).status).toBe(0);
    expect(git(["commit", "-m", "topic"]).status).toBe(0);
    expect(git(["checkout", "master"]).status).toBe(0);
    const evil = {
      ...good,
      GIT_AUTHOR_NAME: "Evil Agent",
      GIT_AUTHOR_EMAIL: "evil@example.invalid",
      GIT_COMMITTER_NAME: "Evil Agent",
      GIT_COMMITTER_EMAIL: "evil@example.invalid",
    };
    expect(
      git(["merge", "--no-ff", "topic", "-m", "merge topic"], evil).status,
    ).toBe(0);
    const output = spawnSync(
      process.execPath,
      [join(repo, "scripts/check-banned.mjs")],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, RATIO_BASE: base },
      },
    );
    expect(output.status).toBe(1);
    expect(output.stdout).toContain("author is");
    expect(output.stdout).toContain("committer is");
  });
});

describe("pre-commit hook semantic validation", () => {
  it("rejects required command text hidden in comments", () => {
    const root = temp();
    put(
      root,
      "lefthook.yml",
      [
        "min_version: 2.1.12",
        "pre-commit:",
        "  commands:",
        "    fake:",
        "      run: echo harmless",
        "      # BANNED_DIFF_CACHED=1 npm run check:banned",
        "      # npm run check:production-preflight",
        "      # npm run lint",
        "      # npm run type-check",
        "      # npm run format:check",
      ].join("\n"),
    );
    const output = spawnSync(
      process.execPath,
      [join(repo, "scripts/check-hook-config.mjs")],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(output.status).toBe(1);
    expect(output.stdout).toContain("banned");
  });
});
