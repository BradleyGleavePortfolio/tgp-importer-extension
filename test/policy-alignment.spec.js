import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const retained = [
  "check:banned",
  "check:flags",
  "check:fixtures",
  "check:production-preflight",
  "check:hooks",
  "lint",
  "type-check",
  "format:check",
];
const made = [];
function temp() {
  const root = mkdtempSync(join(tmpdir(), "importer-policy-alignment-"));
  made.push(root);
  return root;
}
function put(root, path, body) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}
const identity = {
  GIT_AUTHOR_NAME: "Bradley Gleave",
  GIT_AUTHOR_EMAIL: "bradley@bradleytgpcoaching.com",
  GIT_COMMITTER_NAME: "Bradley Gleave",
  GIT_COMMITTER_EMAIL: "bradley@bradleytgpcoaching.com",
};
function git(root, args, overrides = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...identity, ...overrides },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function check(root, script) {
  return spawnSync(process.execPath, [join(repo, "scripts", script)], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, RATIO_BASE: "HEAD~1", BANNED_DIFF_CACHED: "0" },
  });
}
afterEach(() =>
  made
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

describe("volume-policy retirement preserves safety wiring", () => {
  it("keeps tests, dependency audit and every retained CI gate unconditional", () => {
    const workflow = parse(
      readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8"),
    );
    expect(workflow.on).toEqual({
      push: { branches: ["**"] },
      pull_request: null,
    });
    const job = workflow.jobs.test;
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    const commands = [
      "npm ci",
      "npm test",
      "npm audit --audit-level=high",
      "node scripts/check-banned.mjs",
      "node scripts/check-flag-discipline.mjs",
      "node scripts/check-production-fixtures.mjs",
      "node scripts/check-deploy-readiness.mjs",
      "node scripts/check-hook-config.mjs",
      "npm run lint && npm run type-check && npm run format:check",
    ];
    const steps = job.steps.filter((step) => step.run !== undefined);
    expect(steps.map((step) => step.run)).toEqual(commands);
    for (const step of steps) {
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
    }
    expect(manifest.scripts.test).toMatch(
      /^vitest run(?: --passWithNoTests=false)?$/,
    );
    expect(manifest.scripts["check:loc"]).toBeUndefined();
    expect(manifest.scripts["check:ratio"]).toBeUndefined();
  });

  // Execute the actual aggregate shell command with a controlled npm child:
  // proves ordering and nonzero propagation, not the children themselves.
  it.each(["", ...retained])(
    "the aggregate executes all checks or fails closed at %s",
    (failure) => {
      const root = temp();
      put(
        root,
        "npm",
        [
          `#!${process.execPath}`,
          'const fs = require("node:fs");',
          'const command = process.argv.slice(2).join(" ");',
          'fs.appendFileSync(process.env.TRACE, command + "\\n");',
          'process.exit(command === "run " + process.env.FAIL_AT ? 23 : 0);',
        ].join("\n"),
      );
      chmodSync(join(root, "npm"), 0o755);
      const result = spawnSync("/bin/sh", ["-c", manifest.scripts.gates], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          TRACE: join(root, "trace"),
          FAIL_AT: failure,
        },
      });
      expect(result.status, result.stderr).toBe(failure ? 23 : 0);
      const expected = failure
        ? retained.slice(0, retained.indexOf(failure) + 1)
        : retained;
      expect(
        readFileSync(join(root, "trace"), "utf8").trim().split("\n"),
      ).toEqual(expected.map((name) => `run ${name}`));
    },
  );
});

describe("retained checks do not depend on volume accounting", () => {
  it.each(["clean", "silent catch", "dependency pin", "author", "committer"])(
    "checks a large source-only change: %s",
    (mutation) => {
      const root = temp();
      put(root, "package.json", JSON.stringify({ private: true }));
      git(root, ["init"]);
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      // Deliberately over the retired push cap, with no test lines.
      const source = Array.from(
        { length: 628 },
        (_, index) => `export const value${index} = ${index};`,
      );
      if (mutation === "silent catch")
        source.push("Promise.resolve().catch(() => undefined);");
      put(root, "shared/large.js", source.join("\n") + "\n");
      if (mutation === "dependency pin")
        put(
          root,
          "package.json",
          JSON.stringify({ private: true, dependencies: { sample: "^1.0.0" } }),
        );
      git(root, ["add", "."]);
      const overrides =
        mutation === "author"
          ? { GIT_AUTHOR_NAME: "Wrong identity" }
          : mutation === "committer"
            ? { GIT_COMMITTER_NAME: "Wrong identity" }
            : {};
      git(root, ["commit", "-m", "source-only change"], overrides);
      const result = check(root, "check-banned.mjs");
      expect(result.status, result.stderr).toBe(mutation === "clean" ? 0 : 1);
      const markers = {
        clean: "OK: banned-token net clean",
        "silent catch": "R75 net-new banned token",
        "dependency pin": "not pinned exactly",
        author: "author is",
        committer: "committer is",
      };
      expect(result.stdout).toContain(markers[mutation]);
    },
  );

  it.each([
    ["true", 0],
    ["false", 1],
    ["undefined", 1],
  ])(
    "still rejects missing or disabled sole auth flags: %s",
    (value, status) => {
      const root = temp();
      put(
        root,
        "shared/protocol.js",
        `export const PAIRING_ENABLED = ${value};\n`,
      );
      expect(check(root, "check-flag-discipline.mjs").status).toBe(status);
    },
  );

  it("the unchanged test command fails when no tests are discovered", () => {
    const root = temp();
    const args = manifest.scripts.test.split(" ").slice(1);
    const result = spawnSync(
      process.execPath,
      [join(repo, "node_modules/vitest/vitest.mjs"), ...args],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("No test files found");
  });
});
