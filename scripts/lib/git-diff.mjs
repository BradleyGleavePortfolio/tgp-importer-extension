// Shared git-diff helpers for the mechanical CI gates. Diff-scoping (rather than
// a hardcoded file list) is deliberate: a gate that enumerates files can be
// defeated by adding a new source file it forgot to list. A diff walk counts
// every changed line of every changed file, so a new source can never be
// silently omitted from the measurement.
import { execSync } from "node:child_process";

function sh(cmd) {
    return execSync(cmd, { encoding: "utf8" }).trim();
}

// Resolve the base ref this branch forked from. Honours an explicit override,
// then the GitHub PR base, then origin/main, then a local main.
export function resolveBase() {
    const candidates = [
        process.env.RATIO_BASE,
        process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null,
        "origin/main",
        "main",
    ].filter(Boolean);
    for (const ref of candidates) {
        try {
            sh(`git rev-parse --verify --quiet ${ref}^{commit}`);
            return ref;
        }
        catch {
            // try the next candidate
        }
    }
    throw new Error("check-gates: could not resolve a base ref (tried RATIO_BASE, GITHUB_BASE_REF, origin/main, main)");
}

export function mergeBase(base) {
    return sh(`git merge-base ${base} HEAD`);
}

// Category of a repo-relative path for gate accounting.
export function classify(path) {
    if (path.includes("node_modules/")) return "ignore";
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) return "ignore";
    if (/(^|\/)(?:test|tests|__tests__)\//.test(path) || /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path)) return "test";
    if (path.startsWith("scripts/")) return "ignore"; // gates + tooling are not shipped
    return "prod";
}

// Added/removed line counts per category for `base...HEAD`.
export function diffLineStats(base) {
    const from = mergeBase(base);
    const raw = sh(`git diff --numstat ${from} HEAD`);
    const stats = { prod: { added: 0, removed: 0 }, test: { added: 0, removed: 0 } };
    if (raw === "") return stats;
    for (const line of raw.split("\n")) {
        const [addRaw, delRaw, path] = line.split("\t");
        if (!path) continue;
        const cat = classify(path);
        if (cat === "ignore") continue;
        // Binary files report "-"; treat as 0 lines.
        const added = addRaw === "-" ? 0 : Number(addRaw);
        const removed = delRaw === "-" ? 0 : Number(delRaw);
        stats[cat].added += added;
        stats[cat].removed += removed;
    }
    return stats;
}
