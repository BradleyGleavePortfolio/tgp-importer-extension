# R138 — Land Split-2 credential-name grammar and text redaction

**Status:** Accepted; implementation landed 2026-09-10  
**Decision scope:** CF-1  
**Landing commit:** `8a530bd2082a895e20a84fbe4779f9a3476c5443` on `main`  
**Pull request:** #13 (`split-2-credential-grammar`)

## Decision

Accept and land Split-2 by squash-merging PR #13. The change delivers the CF-1
root fix: a token-boundary-aware credential-name classifier, together with
credential-shaped text redaction and focused regression coverage.

## Audit result

The single quick-audit round returned **CLEAN** on the first round for the exact
audited head `33696303152db08348386ef5797f1104820986dd`.

Canonical LOC accounting recorded 104 production additions and 479 test
additions, for a test-to-production ratio of **4.606**.

## Landing mechanism

With explicit operator authorization, `main` branch protection's
`required_approving_review_count` was changed from 1 to 0 for the merge only.
Every other protection setting remained unchanged. PR #13 was squash-merged,
then the original full protection configuration was restored immediately, with
`required_approving_review_count` back at 1 and an exact before/after match.

## Evidence

- PR #13 authorized head: `33696303152db08348386ef5797f1104820986dd`
- Squash commit on `main`: `8a530bd2082a895e20a84fbe4779f9a3476c5443`
- Final audit verdict: CLEAN on the first quick-audit round
- Required PR checks before merge: `test` and `codeql`, successful
- Canonical LOC: 104 production / 479 test / ratio 4.606
- Branch-protection audit: review count 1 → 0 → 1; exact restoration verified
