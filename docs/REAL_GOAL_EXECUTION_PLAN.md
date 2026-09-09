# TGP Importer Real-Goal Execution Plan

> **Status:** binding operator baton, effective 2026-09-09.
> **Baseline:** `main` at `d9b49b4f55456fa1ad1f8c78567d3c71a45386a7`.
> **Mission source:** `IMPORTER_HANDOFF_EXPANSION_PLUS_WORK_DELETION.docx`.
> **Companions:** `ROADMAP.md`, `AUTO_DISCOVERY.md`,
> `DECISION_V03_AUTONOMOUS_CRAWL.md`, `TIER0_CONTRACT_INTEGRITY.md`.

## Mission

Build the simplest safe system that can truthfully say:

> "I have never seen this platform before, but I can figure out how to move
> this coach's business into TGP."

The product is not a catalog of competitor-specific scrapers. It is a generic
migration machine:

```
OBSERVE → UNDERSTAND → ACT → OBSERVE AGAIN → VERIFY → IMPORT → VERIFY RESULT
```

AI may plan which bounded, read-only action should happen next. Deterministic
code owns execution, origin confinement, budgets, extraction, replay,
idempotency, settlement, and truthfulness.

## Non-negotiable product invariants

1. **Site-agnostic core.** No competitor names, host maps, endpoint maps, or
   selector packs in `shared/blueprint/*`, `shared/replay/*`, or the adaptive
   planner/executor core.
2. **Read-only source behavior.** Source-platform requests are GET/HEAD and a
   finite allowlist of explicitly modeled read-only browser actions. Never
   send messages, modify records, change billing, or invoke arbitrary
   model-generated JavaScript.
3. **Credentials remain capabilities, not data.** Capture-buffer entries stay
   redacted. Inference must never require raw Authorization, Cookie,
   Set-Cookie, password, token, or payment credentials. Runtime source auth
   remains ephemeral and is injected through the already-hardened trusted-tab
   seam.
4. **Fail closed.** An inferred blueprint is untrusted input. It must pass the
   existing `normalizeBlueprint(..., {allowedOrigins})` boundary before any
   source request. Low confidence, cross-origin ambiguity, unsupported method,
   malformed pagination, or incomplete identity relationships must not start
   a crawl.
5. **Bounded execution.** Preserve max-pages, per-step max-pages,
   max-entities, timeout, retry, pacing, dedupe, abort, auth-loss, and
   backpressure limits.
6. **Truthful outcomes.** Empty, partial, failed, cancelled, and successful
   outcomes remain distinct. Every terminal path settles once and reports
   actual per-entity counts.
7. **Native TGP destination.** `ScoutReconstructedEntity` is a staging/audit
   representation, not the final product for non-person families. Imported
   records must eventually behave like native TGP records.
8. **Oracle, not template.** Keep TrueCoach intact as a known-good oracle and
   regression baseline. Do not use it as the template for nine more
   hand-written extractors.
9. **No hidden releases.** A newly encountered JSON-driven platform should be
   learnable without shipping competitor-specific production code.
10. **Quality over speed.** Every product-code PR follows the canonical
    builder → dual-independent-auditor → fixer → fresh dual-auditor cycle until
    both auditors return `VERDICT: CLEAN`.

## Reality at the baseline

### Shipped

- Passive, tab-scoped CDP network capture with bounded memory and redaction.
- Declarative `PlatformBlueprint` contract and fail-closed normalizer.
- Bounded replay state machine and generic many-page replay engine.
- Trusted runtime wiring, source-token handoff, origin allowlist, progress,
  settlement, and honest result vocabulary.
- Data-only TrueCoach blueprint used as the known oracle.
- A structurally independent `conformance_alpha` fixture proving the generic
  replay engine can drive a non-TrueCoach graph with zero production changes.

### Missing

- Capture-buffer → blueprint inference.
- Learn/Confirm runtime and coach-facing workflow.
- A live second-platform proof with no hand-written production adapter.
- Active discovery of missing families.
- Deterministic safe-action executor plus AI planner boundary.
- Generic DOM/table observation and SSR fallback.
- Native reconstruction for non-person families.
- Export fallback and reusable non-secret learned-platform knowledge.

## Design contradictions resolved by this plan

### PR-C2 cannot be one 500-LOC PR

`AUTO_DISCOVERY.md` estimates the inference brain at approximately 500
production lines, while current doctrine and CI cap each PR at 400 added
production lines. C2 is therefore split at pure import seams into C2a, C2b,
and C2c. Each unit is independently testable and useful; no exception request
is planned.

### Capture redaction is permanent

Older prose says replay receives "captured cookies/bearer" and gives
"auth inferable" a confidence weight. The live capture layer deliberately
redacts those secrets before buffering, and the runtime already has a safer
ephemeral source-auth seam. The implementation must not weaken redaction to
make old prose true. Structural header-name consistency may be measured, but
secret values are neither inferred nor stored, and auth does not increase
blueprint confidence merely because a secret-looking header existed.

### Deterministic inference and AI-assisted adaptation are separate layers

Deterministic inference handles network shapes, URL structure, endpoint roles,
pagination, and joins. AI enters later only to choose among a finite set of
safe read-only exploration actions when required migration families remain
missing. This captures the GOOD of AI planning without allowing model output
to execute code or invent network requests.

## Critical-path PR chain

Each product-code PR is ≤400 added production LOC, test:source ratio ≥2.0,
R3-authored, CI-green under the real `pull_request` environment, and fully
dual-audited. Dates are intentionally omitted; readiness is evidence-based.

### NOW: C2a — Inference primitives

**Purpose:** Convert redacted capture entries into stable, deterministic
structural evidence without producing a runnable blueprint yet.

**Production scope**

- `shared/blueprint/input.js`
  - Validate and normalize capture snapshots.
  - Parse JSON bodies safely and bound nesting/collection work.
  - Accept only safe HTTPS observations and GET/HEAD evidence.
  - Preserve origin, path structure, query-key names, method, response status,
    timestamps, and redacted headers; never recover or persist secret values.
- `shared/blueprint/url-templates.js`
  - Cluster same-origin URL paths deterministically.
  - Collapse a path segment only after sufficient distinct-value evidence.
  - Preserve static API-version segments such as `v2`.
  - Never carry captured query values into a template; retain only supported
    pagination/window parameter names as evidence.
- `shared/blueprint/shapes.js`
  - Generate stable, sorted depth-bounded signatures.
  - Distinguish array/object/scalar/null and nested types without storing
    coach PII in the signature.
  - Cluster equivalent response shapes independent of object key order.

**Acceptance evidence**

- Identical input produces byte-identical evidence regardless of capture
  order where order is not semantically relevant.
- TrueCoach fixture clusters `/clients/<id>` correctly without collapsing
  `/api/v2/`.
- False-ID fixtures cover dates, decimals, API versions, one-off numeric
  routes, UUIDs, integers, and short IDs.
- Malformed JSON, huge/deep input, redacted tokens, mixed origins,
  unsupported methods, and prototype-like keys fail closed or are excluded
  with an explicit reason.
- Tests prove no captured PII value appears in shape signatures or templates.
- No `chrome.*`, network I/O, timers, random values, or competitor-specific
  production logic.

**Explicitly out of scope:** endpoint roles, joins, confidence, runnable
blueprint emission, UI, runtime wiring.

### NEXT: C2b — Endpoint roles, pagination evidence, and relationship graph

**Purpose:** Turn C2a evidence into a candidate entity/endpoint graph.

**Production scope**

- `shared/blueprint/roles.js`
  - Infer list/detail/windowed/paginated roles from response shape, templates,
    and query-key evidence.
- `shared/blueprint/edges.js`
  - Infer candidate ID fields and cross-cluster relationships from observed
    value-set overlap.
  - Record support count, contradiction count, and provenance for each edge.
- `shared/blueprint/pagination.js`
  - Infer only pagination forms the existing replay contract can represent.
  - Refuse ambiguous or unsupported schemes rather than guessing.

**Acceptance evidence**

- Handles body-array and nested-array list responses.
- Distinguishes list endpoints from detail endpoints and metadata wrappers.
- Requires repeated observations before declaring an edge.
- Does not mistake timestamps, enums, booleans, or ubiquitous tenant IDs for
  entity relationships.
- Cyclic, ambiguous, and unrepresentable graphs are explicitly diagnosed.
- Entire layer stays pure, deterministic, and competitor-neutral.

### NEXT: C2c — Blueprint compiler, confidence, and compatibility proof

**Purpose:** Produce an untrusted candidate `PlatformBlueprint` that the
existing normalizer can either accept safely or reject.

**Production scope**

- `shared/blueprint/confidence.js`
  - Score evidence completeness, repeatability, contradictions, graph
    coherence, pagination certainty, and representability.
  - Return component scores and reasons, not a magic scalar alone.
- `shared/blueprint/compile.js`
  - Topologically order list/fan-out steps.
  - Emit only fields supported by the existing replay contract.
  - Attach provenance/evidence separately from the runnable blueprint.
- `shared/blueprint/index.js`
  - Public `induceBlueprint(captureSnapshot)` entry point.

**Acceptance evidence**

- Every emitted candidate is immediately passed through
  `normalizeBlueprint` using the observed trusted origin; unsafe or
  structurally invalid candidates never escape as ready.
- TrueCoach captured evidence compiles to a behaviorally equivalent crawl
  graph, compared by emitted records and terminal counts, not object-text
  equality.
- `conformance_alpha`-style second structure proves no TrueCoach coupling.
- Low-confidence and contradictory fixtures return `not_ready` with
  actionable missing evidence; they do not emit runnable partial blueprints.
- Confidence thresholds are calibrated against fixtures and documented; no
  credential-presence score.

### NEXT: C3a — Learn-session runtime

**Purpose:** Expose capture + inference behind a real, non-dead-end runtime
flow while keeping import disabled until the candidate is safe.

**Scope**

- Trusted extension-page messages: `start_learning`, `learning_snapshot`,
  `stop_learning`.
- One learning session per source tab; synchronous single-flight guard.
- Explicit debugger lifecycle, timeout, cancellation, service-worker restart,
  tab-close, and detach handling.
- Inference runs against snapshots without persisting raw capture data.
- Coach sees observed endpoint/response counts, confidence components,
  missing evidence, and a precise next instruction.

**Gate:** no "Import" action is enabled in this PR. The UI provides real
learning value and real errors, so it is not a coming-soon stub.

### NEXT: C3b — Confirm and autonomous import

**Purpose:** Connect a confirmed inferred blueprint to the existing replay
engine and Tier-0 settlement path.

**Scope**

- Human-readable confirmation summary: origin, entity families, estimated
  observations, inferred relationships, confidence, and unknowns.
- Explicit coach confirmation before the first autonomous source request.
- Revalidate origin permission and normalize the candidate immediately before
  replay; never trust the earlier preview.
- Pacing uses observed cadence conservatively; never faster than the source
  session.
- Existing progress, retry, auth-loss, idempotency, and settlement machinery
  remains the only ingest path.

**Gate:** end-to-end fixture proof of Learn → Confirm → Replay → Ingest →
Settle, including empty/partial/failed outcomes.

### NEXT: V1 — First real unknown-platform vertical slice

**Purpose:** Prove the mission, not merely the architecture.

**Candidate:** Everfit is the current first choice because the roadmap already
identifies its coach web app and it is structurally different from TrueCoach.
This is a choice, not a hard-coded dependency; use another real JSON-driven
coaching platform if access/evidence is better.

**Required proof**

- No production adapter, endpoint map, host-specific branch, or selector pack
  added for the target.
- Pin extension, backend, and mobile SHAs and record account, browser,
  timestamps, observed counts, emitted counts, retries, failures, settlement,
  and final backend state.
- Compare target-system counts against source-visible counts by family.
- Demonstrate replay/idempotency by safely repeating the same intent.
- Demonstrate source-auth loss, TGP-auth loss, low-confidence refusal,
  malformed response, rate-limit/backoff, cancellation, and rollback.
- Record every gap as inference, replay, reconstruction, or product-flow debt;
  never fix the proof by adding a target-specific scraper.

**Exit condition:** a coach can complete a real migration from a platform for
which TGP shipped no production extractor.

### LATER: A1 — Generic page observation

Build a compact DOM evidence layer for visible text, headings, buttons, links,
tables/rows, repeated structures, relevant safe attributes, and current URL.
No platform-specific selectors in the core, no giant semantic-browser
framework, and no raw DOM dump to an AI service.

### LATER: A2 — Safe-action contract and deterministic executor

Define a closed action vocabulary:

- click an identified button/tab;
- open an identified link/detail;
- expand an identified row;
- next page;
- bounded scroll;
- open a menu;
- trigger an official export;
- wait for navigation/network idle.

Every action carries target provenance, expected observation, timeout,
same-origin constraints, and a destructive-risk classification. The executor
rejects anything outside the vocabulary and records before/after evidence.

### LATER: A3 — AI planner for missing migration capabilities

The planner receives compact redacted evidence, required-family gaps, and the
safe-action schema. It returns one schema-valid action proposal plus rationale
and expected evidence. Deterministic policy validates or refuses it; the model
never writes JavaScript, URLs, selectors, fetch calls, or source mutations.

Required tests include prompt injection in page text, malicious labels,
cross-origin links, hidden destructive controls, action loops, repeated no-op
actions, and budget exhaustion.

### LATER: A4 — Observe/action loop and active-discovery proof

Run bounded:

```
observe → infer gaps → plan one safe action → policy validate → execute
→ observe delta → verify progress → repeat or stop
```

Stop on confidence reached, no-progress budget, repeated state, auth loss,
origin change, destructive ambiguity, user cancellation, or global budget.
Prove discovery of one family not visited manually, such as billing.

### LATER: D1 — DOM/SSR and table fallback

Feed generic DOM/table evidence into the same discovery representation and
compiler. Signed platform selector packs may exist only as a fallback after
generic observation fails, with an evidence-backed exception record.

### LATER: R1 — Native reconstruction expansion

Audit backend destination schemas and split per family. Each PR reconstructs
one family into native TGP records with provenance, idempotency, referential
integrity, rollback, and reconciliation. Billing includes state/history but
never payment credentials; payment migration uses the legitimate provider
re-tokenization path.

### LATER: F1 — Exports and learned-platform memory

- Treat official exports as another observation source that converges on the
  same discovery representation.
- Persist reusable non-secret structural knowledge only after a successful,
  verified migration.
- Version, sign, expire, and invalidate learned knowledge when observed
  structure drifts.

## Cross-repository dependency map

| Dependency | Why it matters | Required by | Contingency |
|---|---|---|---|
| Importer PR #9 | Honest Tier-0 progress/settlement and data-loss prevention | already complete | none |
| Backend PR #522 | Include `entity_type` in ingest idempotency identity | first production vertical slice | block production proof; fixture proof may continue |
| Mobile #289–#292 | Deterministic build, independent review kill switch, durable pairing/correlation, honest pairing UX | production flag activation | web/extension dev proof may continue; no production flag |
| Native reconstruction family PRs | Make imports behave like native TGP data | family-complete migrations | keep staging record + truthful partial capability status |
| Real second-platform access | Calibrate inference against reality | C2c and V1 | use synthetic fixtures for development only; do not claim mission proof |

The DUN backend ladder is not on this importer's feature critical path unless
a concrete shared dependency is found. Do not block importer progress merely
because it appears earlier in an old global landing list; apply the current
root-cause test.

## Operator handoff protocol

Every baton pass must state:

1. repo, base SHA, branch, PR URL, and exact head SHA;
2. which plan slice is being implemented;
3. production LOC added/removed under the real pull-request base;
4. tests added, tests run, and exact pass counts;
5. all gate commands and outputs, including `PROD_LOC_CAP=400`;
6. security/PII/credential/write-back analysis;
7. scope completed, scope deliberately deferred, and why the PR is not a
   user-visible dead end;
8. R138 four-question decision record and rollback/blast radius;
9. audit status and paths to reports;
10. the single next executable action.

Do not hand off with vague phrases such as "mostly done", "should pass", or
"ready for review". Evidence or it did not happen.

## Required audit cycle for every product-code PR

1. Builder works only from the plan slice and live base; no audit role.
2. CI and local gates pass using the pull-request environment.
3. Two fresh independent auditors receive the same facts but no builder
   conclusions and no prior audit findings.
4. Every round is a fresh aggressive hunt for any P0–P3 defect, not merely a
   recheck of earlier findings.
5. Any finding blocks landing. A separate fixer closes all findings.
6. Two new independent auditors audit the new exact head from scratch.
7. On dual `VERDICT: CLEAN`, land automatically under the standing
   authorization using the R3 manual squash + plain fast-forward procedure.
   Never use `gh pr merge` on production `main`.

Pure context/doctrine documents remain audit-exempt, but architecture pivots
must carry an R138 decision record and `DECISION_LOG.md` entry.

## Stop conditions

Stop the active slice and write a scope/decision record if any of these occur:

- the clean seam cannot fit under 400 production LOC;
- a step requires weakening capture redaction or persisting source secrets;
- the generic core needs a competitor name or host-specific branch;
- inference output cannot be represented by the current replay contract;
- a safe action cannot be proven read-only;
- the second-platform proof needs platform-specific production code;
- backend reconstruction would silently drop or flatten source semantics;
- CI passes only under push defaults but not the real pull-request context;
- a user-visible control would lead to a stub, fake success, or unactionable
  error.

## Success scoreboard

| Metric | First gate | North-star target |
|---|---:|---:|
| Unknown JSON platforms migrated without production adapter | 1 | 8 of top 10 |
| Blueprint precision on accepted candidates | 100% in proof set | ≥90% without coach edits |
| Entity recall vs source-visible counts | ≥98% in first vertical slice | ≥98% |
| False-success rate | 0 | 0 |
| Source write operations | 0 | 0 |
| Secret values persisted in capture/blueprint/learned knowledge | 0 | 0 |
| Median install-to-first-import | record baseline | <4 minutes |
| New-platform-specific production LOC | 0 in vertical slice | 0 for JSON path |

## Immediate baton

**Start C2a now.** The builder owns only inference primitives and their tests.
It must not wire UI/runtime, emit runnable blueprints, or add a platform
adapter. When the builder produces a CI-green PR under 400 production LOC,
dispatch fresh Lens A and Lens B auditors against the exact head. On genuine
dual CLEAN, land automatically and advance to C2b.
