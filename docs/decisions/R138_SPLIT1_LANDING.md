# R138 — Land Split-1 honest gates and CI/toolchain hardening

**Status:** Accepted; implementation landed 2026-09-10  
**Decision scope:** CF-3, CF-4, CF-5, CF-7, CF-9  
**Landing commit:** `38c0a6887533a5eada3f4f10147f0088625228f1` on `main`  
**Pull request:** #12 (`split-1-honest-gates`)

## Decision

Accept and land Split-1 by squash-merging PR #12. Its scope supersedes the
corresponding CF-3, CF-4, CF-5, CF-7, and CF-9 scope originally carried by PR
#11. The landed change makes the policy gates honest, enforces CI and CodeQL,
hardens the repository toolchain and hook configuration, and adds regression
coverage accumulated through five audit/fix rounds.

## Landing mechanism

GitHub does not permit a pull-request author to satisfy the required approval by
self-approving. With explicit operator authorization, `main` branch protection's
`required_approving_review_count` was changed from 1 to 0 for the merge only.
Every other protection setting remained unchanged. PR #12 was squash-merged,
then the original full protection configuration was restored immediately, with
`required_approving_review_count` back at 1 and an exact before/after match.

## Accepted narrow limitation

The five-round audit converged on content-aware matching for findings in
callbacks that share duplicate structural paths. For the irreducible case where
identical callback bodies exchange positions, move detection uses Git pure
deletion/addition hunks as a last-resort reorder signal. Replacement-hunk
transfers remain classified as changes, and line correspondence alone cannot
establish identity. This narrow, documented duplicate-path callback
move-detection limitation is accepted.

## Evidence

- PR #12 authorized head: `e7dcb7d067aa884ea00c005ec0161a5c3f689543`
- Squash commit on `main`: `38c0a6887533a5eada3f4f10147f0088625228f1`
- Five-round final audit/fixer report: `SPLIT1_R5_FIXER_REPORT.md` in the landing
  audit artifacts
- Required PR checks before merge: `test` and `codeql`, successful
- Branch-protection audit: the saved pre-merge configuration and exact restored
  post-merge configuration match byte-for-semantics; only the temporary review
  count changed during the landing window
