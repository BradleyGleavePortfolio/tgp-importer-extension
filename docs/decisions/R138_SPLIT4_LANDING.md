# R138 — Land Split-4 bounded evidence primitives

**Status:** Accepted; implementation landed 2026-09-10  
**Decision scope:** CF-7  
**Landing commit:** `8e8bfc53b0530fd2bbadf6a487bcd22e14d0bee7` on `main`  
**Pull request:** #15 (`split-4-shapes-capture-buffer`)

## Decision

Accept and land Split-4 by squash-merging PR #15. The landed change delivers
privacy-preserving shape signatures and a byte-accounted capture buffer with a
hard ceiling, bounded hostile-object handling, immutable snapshots, and an
oldest-first eviction policy with atomic rejection of individually oversized
entries.

CF-7 canonical formatting and presentation is delivered for
`shared/blueprint/shapes.js` and `shared/capture-buffer.js`. Both production
files remain ordinary canonical source without formatter exemptions or
minified/compressed presentation.

## Audit and size

The single quick-audit round returned **CLEAN** on its first round. The canonical
change size was 214 production LOC and 844 test LOC, for a test-to-production
ratio of 3.944.

## Landing mechanism

GitHub does not permit a pull-request author to satisfy the required approval by
self-approving. With explicit operator authorization, `main` branch protection's
`required_approving_review_count` was changed from 1 to 0 for the merge only.
Every other protection setting remained unchanged. PR #15 was squash-merged,
then the original full protection configuration was restored immediately, with
`required_approving_review_count` back at 1 and an exact before/after match.

## Evidence

- PR #15 authorized head: `bc3563af91d0b2e24bd6397bcdeba0f9e6cd1c7f`
- Squash commit on `main`: `8e8bfc53b0530fd2bbadf6a487bcd22e14d0bee7`
- CF-7 delivered for `shared/blueprint/shapes.js` and
  `shared/capture-buffer.js`
- First-round quick-audit verdict: **CLEAN**
- Canonical LOC: 214 production / 844 test / 3.944 ratio
- Required checks before merge: `test` and `codeql`, successful
- Post-merge checks on `main`: CI and CodeQL, successful
- Branch-protection audit: the saved pre-merge configuration and restored
  post-merge configuration match exactly; only the temporary review count
  changed during the landing window
