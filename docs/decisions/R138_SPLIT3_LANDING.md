# R138 — Land Split-3 bounded capture-input normalization

**Status:** Accepted; implementation landed 2026-09-10  
**Decision scope:** CF-1, CF-2  
**Landing commit:** `1f1d244db8a0ee35dae4b1b0bbe5a631bbc90664` on `main`  
**Pull request:** #14 (`split-3-capture-input-normalization`)

## Decision

Accept and land Split-3 by squash-merging PR #14. The landed change delivers
CF-1 credential redaction by reusing Split-2's credential classifier and CF-2
singleton `expectedOrigin` rejection. Capture-input normalization is bounded by
byte, node, depth, and collection limits and uses deterministic ordering.

## Audit and size

The single quick-audit round returned **CLEAN** on its first round. The canonical
change size was 291 production LOC and 767 test LOC, for a test-to-production
ratio of 2.636.

## Landing mechanism

GitHub does not permit a pull-request author to satisfy the required approval by
self-approving. With explicit operator authorization, `main` branch protection's
`required_approving_review_count` was changed from 1 to 0 for the merge only.
Every other protection setting remained unchanged. PR #14 was squash-merged,
then the original full protection configuration was restored immediately, with
`required_approving_review_count` back at 1 and an exact before/after match.

## Evidence

- PR #14 authorized head: `ded0d9cd8517933ed4123650fc1592ec06364f08`
- Squash commit on `main`: `1f1d244db8a0ee35dae4b1b0bbe5a631bbc90664`
- First-round quick-audit verdict: **CLEAN**
- Canonical LOC: 291 production / 767 test / 2.636 ratio
- Required checks before merge: `test` and `codeql`, successful
- Post-merge checks on `main`: CI and CodeQL, successful
- Branch-protection audit: the saved pre-merge configuration and restored
  post-merge configuration match exactly; only the temporary review count
  changed during the landing window
