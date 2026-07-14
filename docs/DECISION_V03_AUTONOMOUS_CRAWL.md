# DECISION — v0.3 Site-Agnostic Autonomous Multi-Page Crawl (generic core)

> Constitution addendum 2026-07-13 decision record. Concise; no raw
> chain-of-thought. Companion to `docs/AUTO_DISCOVERY.md` (Layers 1–3) and
> `docs/DESIGN.md` (§2 flow, §9 pipeline, §10 progress).

## DECISION

Ship the **pure, site-agnostic contract + lifecycle** of autonomous multi-page
import: the declarative `PlatformBlueprint` contract the replay engine consumes
(`shared/replay/blueprint.js`) with its fail-closed, SSRF-confining normalizer,
and the explicit bounded state machine (`shared/replay/state.js`). Both are pure,
browser-independent modules with no `chrome.*` and no network access, fully
unit-tested against fixtures.

**Scope split (canonical LOC cap = 400).** The full end-to-end unit (engine +
schema + state + resolver + data-only TrueCoach adapter + `start_import`
orchestration in `background.js` + Start Import CTA in the popup) totals ~817
added production lines. The canonical R23/R76 cap is **400** prod LOC (the
stricter wording governs over the repo-CI default of 600). Per doctrine — *split
rather than violate caps, never request an exception* — this is a chain of
dependent PRs along clean import seams (each layer imports the one before it,
never the reverse, so no PR carries dead code):

1. **This PR (#4) — contract + lifecycle (396 prod LOC).** `blueprint.js` (296) +
   `state.js` (100). Pure data schema + fail-closed normalization (incl. SSRF
   scheme/host/origin confinement — resolution-proven template confinement, backslash/
   control-byte + trailing-dot-loopback rejection) + the prototype-safe bounded
   transition table. Nothing invokes it at runtime yet; it is inert by construction.
2. **Chained engine PR (PR-C1a) — the bounded replay engine** (`shared/replay/engine.js`).
   Imports the contract from this PR. Carries the JSON-tuple dedupe key and the
   honest `partial`/`failed`/`cancelled`/`complete` result status with its own
   behavioral test matrix (cycles / dup pages / timeout / abort / 401 / retry /
   backpressure / budget exhaustion / 100×). Opened against this branch, not merged
   ahead of it.
3. **PR-C1b — live wiring layer** (platform resolver, data-only TrueCoach
   verification blueprint, `start_import` orchestration in `background.js`, Start
   Import CTA in the popup). Imports the engine.
4. **PR-C2 — auto blueprint inference** (`shared/blueprint/*`).

The existing `TrueCoachExtractor` (`start_ingest`) remains untouched throughout.
This PR ships **no engine, no resolver, no orchestration, and no CTA** — those are
explicitly deferred to the PRs named above and must not be attested as shipped.

## REAL GOAL

Prove SITE-AGNOSTIC autonomous many-page import: an engine that, given only a
declarative blueprint of endpoint roles + edges (no competitor code in its core),
autonomously flips through many pages under the coach's own session, emits the
locked `_interface.js` envelopes, and drives ingest/progress/complete — bounded
and safe. NOT a TrueCoach-only mapped extractor.

## ROOT CAUSE

C1 (capture) is merged, but nothing yet *replays* observed requests across many
pages. The product core — the generic traversal engine — did not exist; the only
multi-page walker was the hand-mapped TrueCoach extractor, which is a verification
adapter, not the site-agnostic product.

## OPTIONS

1. **Minimal** — extend `TrueCoachExtractor` to a couple more entity types.
   Rejected: entrenches a competitor-specific extractor as the product core;
   violates the site-agnostic invariant; proves nothing generic.
2. **Conventional** — build blueprint *inference* (AUTO_DISCOVERY Layer 2, C2)
   first. Good, pure, testable — but it produces a blueprint nothing yet
   consumes, so it does NOT prove "autonomous multi-page import" this PR, and the
   mandated behavioral test matrix (cycles/dup pages/timeout/abort/401/retry/
   backpressure/budgets/100x) is almost entirely *replay* behavior, not inference.
3. **First-principles (SELECTED)** — build the generic **replay engine** (the
   piece that actually performs autonomous multi-page traversal), define the
   `PlatformBlueprint` contract it consumes, and the explicit bounded state
   machine that governs its lifecycle. The live wiring layer (data-only TrueCoach
   blueprint adapter for verification + resolver + background orchestration + popup
   CTA) is the immediately-following PR (PR-C1b), split out to stay within the LOC
   cap; blueprint *inference* is the subsequent PR (PR-C2) that removes the last
   site-specific descriptor and covers unknown platforms.

**Selection rationale:** Option 3 is the narrowest unit that proves the REAL GOAL
end-to-end with zero dead code, keeps the core generic (engine has no TrueCoach
knowledge), and lands within the LOC cap. The mandated tests *are* the engine spec.

## FIVE-STEP RESULT (make requirements less dumb → delete → simplify → accelerate → automate)

- **Question:** dropped a per-platform extractor framework; the product is one
  generic engine + declarative blueprints.
- **Delete:** no DOM packs, no eval, no remote code, no per-competitor endpoint
  maps in the core. No new manifest permissions (TrueCoach + api origins already
  granted; `optional_host_permissions: *://*/*` already covers future runtime
  grants).
- **Simplify:** traversal expressed as ordered `steps` + collected `id sets`
  (list→paginate→fan-out-over-ids). This single model covers pagination, detail,
  and edges without bespoke code.
- **Accelerate:** all IO injected (`fetchJson`, `emit`, `sleep`, `now`) ⇒ the
  engine is browser-independent and fully unit-testable against fixtures.
- **Automate:** bounded state machine + gates (R74/R76/banned/flags) enforce
  safety and reviewability mechanically.

## IDIOT-INDEX

Core value (generic multi-page traversal) vs. cost: engine + schema + state are
~230 prod LOC; the only site-specific cost is a ~40-line data-only TrueCoach
adapter that is deleted the moment inference lands. Index ≈ low: minimal
site-specific baggage per unit of generic capability.

## EXTREME TEST

100× scale: a 500-page list × 200-client fan-out is bounded by `maxPages` /
`maxEntities` / per-request timeout, serialized emit (backpressure), and a
per-step visited-URL set (cycle/duplicate-page proof). Test asserts the engine
issues a bounded number of requests and terminates regardless of a
pathological/looping server.

## HYPERSCALER LENS

What would Apple/Google/Notion do? A single deterministic engine (no ML, same
blueprint ⇒ same crawl), pure/testable brain, least privilege (runtime origin
grants, GET/HEAD only, credentials reused not copied), fail-closed on auth loss,
and no secret ever logged or persisted. Progress mirrored to both devices via the
existing snapshot shape.

## GOOD WITHOUT BAD

Generic capability WITHOUT: competitor code in the core (`shared/replay/*` has zero
TrueCoach knowledge; the data adapter lands in `extractors/` in PR-C1b), off-target
crawls (the normalizer confines apiBase to https + a caller-injected origin
allowlist and refuses IP-literal / loopback / link-local / localhost hosts and
embedded credentials, and forces root-relative step templates — no static
competitor map in the core), destructive requests (GET/HEAD only, refused at parse
otherwise), or credential exposure (design reuses the in-tab session, TGP bearer
only for ingest, no token persisted/logged). The engine, orchestration, and CTA
that make this LIVE arrive in later chained PRs; this PR ships only the inert,
fully-tested contract + lifecycle.

## EVIDENCE

- `docs/AUTO_DISCOVERY.md` §2 Layer 3 (autonomous replay), §3 flow, §7 risks.
- `docs/DESIGN.md` §7 (MV3/rate-limit/CSP/least-privilege), §9 (pipeline order),
  §10 (progress protocol + `/api/scout/progress`).
- Locked envelope: `extractors/_interface.js` `makeEntity`; ingest body:
  `shared/protocol.js` `makeScoutIngestBody`.
- Bounded transport: `shared/net.js` `fetchWithTimeout` (consumed by the engine PR).
- Behavioral proof shipped HERE: `test/replay-blueprint.spec.js` (fail-closed
  normalization: defaults, budgets, pagination, fan-out ordering, and the SSRF
  scheme/host/origin-allowlist/credential/root-relative confinement matrix) and
  `test/replay-state.spec.js` (exhaustive transition table + terminal re-arm).
- Deferred to the engine PR (PR-C1a): `test/replay-engine.spec.js` +
  `test/replay-engine-edge.spec.js` (cycles, duplicate pages, malformed JSON,
  timeout, abort mid-fetch, 401/auth loss, retry/idempotency, backpressure/budget
  exhaustion asserting `partial`/`failed` status, 100×).

## ROLLBACK / STOP

Inert by construction: this PR ships only pure data schema + a pure transition
table. Neither `blueprint.js` nor `state.js` performs any network or `chrome.*`
call, and nothing in `background.js` or the popup imports them yet (the engine that
consumes the contract lands in PR-C1a; the wiring that invokes the engine lands in
PR-C1b). They are therefore unreachable at runtime; to disable entirely, revert this
PR. No backend contract is newly required; ingest/progress/complete already exist
(backend #500/#501/#504). No release tag is cut here.

## NEXT ACTION (named dependent PRs)

**PR-C1a — Bounded replay engine** (immediate follow-up, opened against this
branch). Adds `shared/replay/engine.js`, importing the contract shipped here. It
carries the collision-safe JSON-tuple dedupe key and the honest
`partial`/`failed`/`cancelled`/`complete` result status (a malformed page,
retry-exhaustion, or a budget-truncated crawl must NOT report ordinary `complete`),
with the full behavioral test matrix. It imports the contract and never the reverse.

**PR-C1b — Live wiring layer** (after PR-C1a). Adds `shared/replay/resolve.js`
(`resolveBlueprint(platform)` registry, `unknown_platform` for all others), the
data-only `extractors/truecoach/blueprint.js` verification adapter, `start_import`
orchestration in `background.js`, and the Start Import CTA in the popup — plus their
tests. This is where the wiring-layer audit findings are MANDATORY and must land:
source-`AuthLostError` must clear ONLY the source session and never the TGP tokens;
a single-flight guard must prevent concurrent `start_import` runs; `start_import`
must be gated by `isTrustedExtensionPage` (not extension-id alone); the popup
Start-Import test must exercise real behavior (not a source-grep); and the e2e path
must carry the source bearer so it truly authenticates. It imports the engine and
never the reverse.

**PR-C2 — Auto blueprint inference** (`shared/blueprint/*`, pure
`induceBlueprint(captureBuffer) → PlatformBlueprint` per AUTO_DISCOVERY §2 Layer 2
+ §4 confidence). It feeds `resolveBlueprint` for arbitrary/unknown platforms from
passively captured JSON and lets the popup's Learn→Confirm states drive the engine,
retiring the TrueCoach data adapter as the sole blueprint source.

## SCOPE DELIBERATELY NOT BUILT (this PR)

- The bounded replay engine (`shared/replay/engine.js`) — PR-C1a above; split out
  to hold the canonical 400 prod-LOC cap. Carries dedupe-key + partial-status fixes.
- Live wiring layer (resolver, TrueCoach data adapter, `start_import`
  orchestration, popup CTA) — PR-C1b above; carries the wiring-layer audit findings.
- Blueprint inference (Pass A/B/C, confidence) — PR-C2 above.
- Learn/Confirm capture UI (`popup/learn.*`) — arrives with inference; the
  LEARNING/CONFIRMING states exist in the state machine now (tested) but are
  driven only after inference lands.
- DOM/SSR fallback packs and export-recipe parsing — AUTO_DISCOVERY §5, later PRs.
- Additional platform adapters — one at a time, API-verified, or via inference.
