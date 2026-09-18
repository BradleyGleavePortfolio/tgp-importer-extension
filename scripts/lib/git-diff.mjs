// Shared base resolution for banned-source/identity and formatting checks.
// RATIO_BASE remains a compatibility override, not a volume quota.
import { execFileSync } from "node:child_process";

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
