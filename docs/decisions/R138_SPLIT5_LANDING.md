# R138 — Land Split-5 URL-template inference and synthetic C2a fixture

**Status:** Accepted; implementation landed 2026-09-10  
**Decision scope:** CF-8, CF-1  
**Landing commit:** `e647f30bcad47610fedd84f2191543179b01ced0` on `main`  
**Pull request:** #16 (`split-5-url-templates-c2a-fixture`)

## Decision

Accept and land Split-5 by squash-merging PR #16. The landed change delivers
the CF-8 month-format guard fix by evaluating `partition.every(...)` rather
than `group.every(...)`, so calendar-month partitions stay literal without
preventing structurally similar non-date numeric partitions from generalizing
to URL templates.

The change also delivers CF-1 end-to-end credential-redaction proof through the
full synthetic C2a pipeline: capture normalization, URL-template inference, and
response-shape clustering. The safe synthetic fixture demonstrates that
credential-shaped header names and redaction markers do not leak into final
template or shape evidence.

## Audit and size

The single quick-audit round returned **CLEAN** on its first round. The canonical
change size was 252 production LOC and 564 test LOC, for a test-to-production
ratio of **2.238**.

## Landing mechanism

With explicit operator authorization, `main` branch protection's
`required_approving_review_count` was changed from 1 to 0 for the merge only.
Every other protection setting remained unchanged. PR #16 was squash-merged,
then the original full protection configuration was restored immediately, with
`required_approving_review_count` back at 1 and an exact before/after match.

## Evidence

- PR #16 authorized head: `2d09b1f7444184e616a9a3a8a5994bc7c0f52b5d`
- Squash commit on `main`: `e647f30bcad47610fedd84f2191543179b01ced0`
- CF-8 delivered: month-format guard uses partition-scoped evaluation
- CF-1 delivered: end-to-end credential-redaction proof through the full C2a
  pipeline with a synthetic fixture
- First-round quick-audit verdict: **CLEAN**
- Canonical LOC: 252 production / 564 test / 2.238 ratio
- Required checks before merge: `test` and `codeql`, successful
- Branch-protection audit: review count 1 → 0 → 1; exact restoration verified
