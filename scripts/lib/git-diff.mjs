// Shared git-diff helpers for the mechanical CI gates. Diff-scoping (rather than
// a hardcoded file list) is deliberate: a gate that enumerates files can be
// defeated by adding a new source file it forgot to list. A diff walk counts
// every changed line of every changed file, so a new source can never be
// silently omitted from the measurement.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "prettier";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// Resolve the base ref this branch forked from. Honours an explicit override,
// then the GitHub PR base, then origin/main, then a local main.
export function resolveBase() {
  const candidates = [
    process.env.RATIO_BASE,
    process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : null,
    "origin/main",
    "main",
  ].filter(Boolean);
  for (const ref of candidates) {
    try {
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return ref;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "check-gates: could not resolve a base ref (tried RATIO_BASE, GITHUB_BASE_REF, origin/main, main)",
  );
}

export function mergeBase(base) {
  return git(["merge-base", base, "HEAD"]);
}

// Category of a repo-relative path for gate accounting.
export function classify(path) {
  if (path.includes("node_modules/")) return "ignore";
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) return "ignore";
  if (
    /(^|\/)(?:test|tests|__tests__)\//.test(path) ||
    /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path)
  )
    return "test";
  if (path.startsWith("scripts/")) return "script"; // tooling is tracked as its own boundary
  return "prod";
}

function content(ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function changedFiles(from) {
  const fields = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "-M", from, "HEAD"],
    { encoding: "utf8" },
  ).split("\0");
  const files = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    const oldPath = fields[index++];
    const newPath = status.startsWith("R") ? fields[index++] : oldPath;
    files.push({ oldPath, newPath });
  }
  return files;
}

async function canonical(source, path) {
  if (!source) return "";
  return format(source, { filepath: path });
}

function numstat(before, after) {
  const root = mkdtempSync(join(tmpdir(), "canonical-diff-"));
  try {
    const left = join(root, "before");
    const right = join(root, "after");
    writeFileSync(left, before);
    writeFileSync(right, after);
    try {
      execFileSync("git", ["diff", "--no-index", "--numstat", left, right], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { added: 0, removed: 0 };
    } catch (error) {
      if (error.status !== 1) throw error;
      const [added, removed] = error.stdout.trim().split("\t");
      return { added: Number(added), removed: Number(removed) };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Canonically formatted added/removed line counts per category for `base...HEAD`.
export async function diffLineStats(base) {
  const from = mergeBase(base);
  const stats = {
    prod: { added: 0, removed: 0 },
    test: { added: 0, removed: 0 },
  };
  for (const { oldPath, newPath } of changedFiles(from)) {
    const oldCat = classify(oldPath),
      newCat = classify(newPath);
    if (!stats[oldCat] && !stats[newCat]) continue;
    const before = await canonical(content(from, oldPath), oldPath);
    const after = await canonical(content("HEAD", newPath), newPath);
    if (oldCat === newCat) {
      if (!stats[newCat]) continue;
      const { added, removed } = numstat(before, after);
      stats[newCat].added += added;
      stats[newCat].removed += removed;
      continue;
    }
    if (stats[oldCat]) stats[oldCat].removed += numstat(before, "").removed;
    if (stats[newCat]) stats[newCat].added += numstat("", after).added;
  }
  return stats;
}
