# R138 Split-7 Landing Decision

## Decision

Split-7 landed on `main` as squash commit `0111be661922234d670bbf23e23d270eec1b4a4e`.

## Delivered finding

CF-6 replay hard-ceiling enforcement is delivered. Runtime replay now computes the remaining blueprint entity budget before allocation and emission, truncates batches to that remainder, and returns `truncated: true` with a non-complete status when additional unique entities exceed the cap. The change covers exact-cap, cap-plus-one, and single huge unpaginated response scenarios.

## Audit and size

The Split-7 audit was **CLEAN on the first pass**.

Canonical LOC was **41 production / 163 test / ratio 3.976**.

## Supersession-plan completion

This landing completes **all seven splits** of the PR #11 supersession plan. The CF-1 through CF-10 findings from the original eight-round PR #11 audit are now fully addressed across Splits 1–7 landed on `main`.
