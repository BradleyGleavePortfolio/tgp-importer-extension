# R138 — Land Split-6 live capture-path security and overload observability

**Status:** Accepted; implementation landed 2026-09-10  
**Decision scope:** CF-1, CF-2, CF-10  
**Landing commit:** `ec7578a6649faa1c4211df654c0b7e0e0f272b31` on `main`  
**Pull request:** #17 (`split-6-live-capture-security`)

## Decision

Accept and land Split-6 by squash-merging PR #17. The landed change delivers
CF-1 live-path credential redaction, corrected after the first audit so request
credentials are redacted before storage rather than after storage. It also
closes the case-insensitive header-classifier bypass and rejects URL userinfo so
credentials cannot leak through either representation.

CF-2 origin enforcement now occurs before storage. The post-audit fix also
prevents a same-requestId cross-origin redirect from reusing an earlier
first-party inflight record and leaking the foreign response body, while
preserving legitimate same-origin redirect handling.

CF-10 adds overload observability with tracked drop reasons.

## Audit and size

Split-6 completed **two audit rounds**. Round 1 found four P1 security findings:

1. Cross-origin redirect body leak.
2. Raw credentials stored before redaction.
3. Case-insensitive classifier bypass.
4. URL userinfo credential leak.

All four findings were fixed, and Round 2 independently verified the fixes with
a **CLEAN** verdict.

The canonical change size was 211 production LOC and 812 test LOC, for a
test-to-production ratio of **3.848**. This exceeded the original 175-line soft
target because of legitimate security fixes, while remaining well under the
400-line absolute production cap.

## Landing mechanism

With explicit operator authorization, `main` branch protection's
`required_approving_review_count` was changed from 1 to 0 for the merge only.
Every other protection setting remained unchanged. PR #17 was squash-merged,
then the original full protection configuration was restored immediately, with
`required_approving_review_count` back at 1 and an exact before/after match.

## Evidence

- PR #17 authorized head: `711bdc57924211373da18f634f6015323115391b`
- Squash commit on `main`: `ec7578a6649faa1c4211df654c0b7e0e0f272b31`
- CF-1 delivered: live-path credential redaction before storage; header-casing
  and URL-userinfo credential bypasses closed
- CF-2 delivered: pre-storage origin enforcement and same-requestId
  cross-origin redirect reuse fixed
- CF-10 delivered: overload observability with tracked drop reasons
- Audit: two rounds; four Round-1 P1 findings fixed; Round 2 **CLEAN**
- Canonical LOC: 211 production / 812 test / 3.848 ratio
- Size policy: over the 175-line soft target for legitimate security fixes;
  under the 400-line absolute cap
- Required checks before merge: `test` and `codeql`, successful
- Branch-protection audit: review count 1 → 0 → 1; exact restoration verified
