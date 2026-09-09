# TGP Importer — Roadmap & Platform Matrix

Companion to `DESIGN.md`, `AUTO_DISCOVERY.md`, and
`DECISION_V03_AUTONOMOUS_CRAWL.md`. This document holds (a) the platform
coverage matrix and (b) the version cutlines.

> **Execution baton:** [`REAL_GOAL_EXECUTION_PLAN.md`](./REAL_GOAL_EXECUTION_PLAN.md)
> is the binding implementation sequence, PR split, proof-gate, and operator
> handoff contract for this north star.

---

## North star (superseded 2026-09-09 — operator course correction)

> **Prior framing (retired):** ship the importer as a series of hand-built,
> per-platform extractors — verify one platform's API, write its extractor,
> ship a release, repeat for the next platform, one at a time through v0.9.

**Current framing (binding):** the importer is a **generic, site-agnostic
migration machine**, not a growing pile of platform-specific scrapers. Its
job is to say, truthfully, *"I have never seen this platform before, but I
can figure out how to move this coach's business into TGP."* A new coaching
platform entering the market should not require TGP to ship a release solely
because that platform exists.

This is not a new invention — it is already the decided architecture
(`DECISION_V03_AUTONOMOUS_CRAWL.md`, `AUTO_DISCOVERY.md`) and substantial
parts of it are **already merged on `main`**: the declarative
`PlatformBlueprint` contract, the fail-closed SSRF-confining normalizer, the
bounded state machine, and the bounded replay engine are live, and a
test-only `conformance_alpha` adapter already proves the engine drives a
second, structurally unrelated synthetic platform end-to-end with **zero**
production code changes (see §"What's already built" below). The prior
roadmap simply hadn't caught up to what the codebase already proves.

**Course correction, effective now:** every future version cutline in this
document is organized around finishing the generic path (capture → inference
→ replay → reconstruction), not around hand-onboarding the next platform in
the matrix. Hand-built extractors are the **fallback of last resort** — used
only where blueprint inference or DOM fallback demonstrably cannot reach an
acceptable confidence — never the default plan of record. Per
`DECISION_V03_AUTONOMOUS_CRAWL.md`'s own decision rule: whenever the proposed
solution is "add another platform-specific scraper," stop and reconsider.

The flagship **TrueCoach extractor remains in place** as the known oracle
used to prove the generic path reproduces a hand-verified result (per
`IMPORTER_HANDOFF_EXPANSION_PLUS_WORK_DELETION.docx`'s vertical-slice
mandate) — it is not being deleted, but it is no longer the template for how
the next nine platforms get built.

---

## What's already built (verified against `main`, 2026-09-09)

| Layer | Status | Where |
|---|---|---|
| Capture layer (CDP passive network capture, ring buffer, redaction) | **Merged** (PR-C1 / "C1 capture") | `shared/capture*.js` |
| `PlatformBlueprint` contract + fail-closed SSRF-confining normalizer | **Merged** (#4) | `shared/replay/blueprint.js` |
| Bounded lifecycle state machine | **Merged** (#4) | `shared/replay/state.js` |
| Bounded, site-agnostic replay engine (cycles/dedupe/pagination/backpressure/auth-loss/honest partial-failed-cancelled-complete status) | **Merged** (#5, PR-C1a) | `shared/replay/engine.js` |
| Live wiring: platform resolver, `start_import` orchestration, Start Import CTA, security hardening (SSRF origin injection, single-flight guard, bearer-spoof resistance, trusted-page gating) | **Merged** (PR-C1b, PR-C1c/#7) | `background.js`, `shared/replay/resolve.js`, `popup/popup.js` |
| Data-only TrueCoach verification adapter (proves the generic engine reproduces the flagship's hand-verified result) | **Merged** | `extractors/truecoach/blueprint.js` |
| Engine-neutrality proof: synthetic `conformance_alpha` adapter, structurally unlike TrueCoach, driven through the unmodified core with an independently hand-authored golden output | **Merged**, test-only | `test/conformance-alpha.spec.js` |
| Blueprint **inference** (Layer 2 — passive capture → blueprint, zero coach/engineer input) | **Not started** | planned: `shared/blueprint/*` (PR-C2) |
| Learn → Confirm capture UI | **Not started** | planned: `popup/learn.*` |
| DOM/SSR fallback extractor + selector packs | **Not started** | planned: Layer 4, PR-C4 |
| Export-recipe fallback (Layer 5) | **Not started** | planned: `docs/export-recipes/*` |

This means the hardest, riskiest generic-core work — the engine that actually
performs autonomous multi-page traversal safely — is done and proven neutral.
What remains is the layer that removes the last human/engineer input from
*discovering* a new platform's shape in the first place.

---

## Version cutlines (superseding all prior v0.1–v1.0 cutlines below)

> **Glossary — "design version" vs "release milestone."** Same convention as
> before: cutlines are release milestones, distinct from `DESIGN.md`'s design
> revision and from `manifest.version`.

### v0.4 — Blueprint inference (Layer 2)  ← **BUILD NEXT**
- `shared/blueprint/url-templates.js`, `shapes.js`, `edges.js`,
  `confidence.js`, `index.js` — pure `induceBlueprint(captureBuffer) →
  PlatformBlueprint` (PR-C2 per `AUTO_DISCOVERY.md` §2 Layer 2, §4, and
  `DECISION_V03_AUTONOMOUS_CRAWL.md`'s "NEXT ACTION").
- Feeds `resolveBlueprint` for arbitrary/unknown platforms from passively
  captured JSON, retiring the TrueCoach data adapter as the *sole* blueprint
  source (it remains as the oracle/regression check, not the only path).
- Pure functions only — no `chrome.*`, no network I/O, fully unit-testable
  against fixtures (TrueCoach capture + at least one real dev capture from a
  second, live JSON-driven platform).

### v0.5 — Learn → Confirm UI + first unknown-platform vertical slice
- `popup/learn.html` / `learn.js` — the Learn/Confirm flow (`AUTO_DISCOVERY.md`
  §3): coach browses their platform normally, popup shows live capture
  progress, flips to "Ready" at confidence ≥ 0.75, coach confirms, replay
  engine runs.
- LEARNING/CONFIRMING states in the existing state machine get driven for
  real (they exist today but are inert pending inference).
- **Vertical-slice proof required by the handoff doc:** run the full
  OBSERVE → DISCOVER → REPLAY/EXTRACT → INGEST → RECONSTRUCT → VERIFY loop
  against one real platform TGP has never hand-built an extractor for,
  end-to-end, with TrueCoach kept intact as the parallel known-good baseline.

### v0.6 — Active/adaptive discovery
- Upgrade discovery from passive-only to active: when a known entity family
  is expected but missing from capture (e.g., billing), identify the gap and
  choose a safe, finite, read-only browser action (click tab/button, open
  detail, expand row, next page, scroll, open menu, trigger official export,
  wait for navigation/network-idle) to go find it.
- AI plans which safe action to take; deterministic code executes it — no
  arbitrary model-generated JavaScript, no source-platform writes, ever.
- Confidence heuristic and safety register extend to cover action-triggered
  discovery, not just passive capture.

### v0.7 — DOM/SSR fallback (Layer 4)
- `extractors/dom/executor.js` + first crowd-sourced `dom-packs/*.json` for
  server-side-rendered platforms where passive JSON capture is useless.
- DOM extraction stays a fallback path behind JSON-API inference, never the
  default — per `AUTO_DISCOVERY.md` §9's explicit non-goal ("no selectors as
  a first-class layer").

### v0.8 — Reconstruction completeness
- Close the gap flagged in the handoff doc: non-person entity families
  (billing, programs, etc.) currently terminate in
  `ScoutReconstructedEntity` instead of becoming real native TGP records like
  `Person` does. Imported data should eventually behave like data created
  natively in TGP.

### v0.9 — Export-recipe fallback (Layer 5) + top-10 coverage checkpoint
- `docs/export-recipes/<platform>.md` guided fallback for encrypted/
  proprietary/mobile-only platforms where neither JSON inference nor DOM
  extraction can reach acceptable confidence.
- Checkpoint against the platform matrix below: report how many of the
  top-10 are now reachable via inference/DOM alone vs. still requiring a
  hand-built extractor or export recipe — hand-built extractors added at
  this point are the explicitly-justified exception, not the default.

### v1.0 — BYO-extractor SDK + learned-platform memory
- Public `_interface.js` as an NPM package; signed side-load path for
  long-tail extractors against the locked contract without a core release.
- Persist reusable, non-secret structural knowledge from successful
  unknown-platform migrations so the next coach on the same platform skips
  the Learn phase (per the handoff doc's "long-term learning" requirement).

---

## Platform matrix

Rows are the target top-10 coaching platforms. TrueCoach is the flagship and
the only platform whose shapes are locked from a live capture (2026-06-30);
it also doubles as the oracle that verifies the generic engine. Every other
row is a candidate for the **inference path (v0.4–v0.6)** first — a row only
gets a hand-built extractor if inference and DOM fallback both prove
insufficient for it, and that must be recorded as a specific, evidenced
exception, not a default.

| Platform | Tier-1 host pattern | API base | Auth mechanism | Client model shape | Verified from live capture? | Import path | Notes |
|---|---|---|---|---|---|---|---|
| **TrueCoach** | `*.truecoach.co`, `app.truecoach.co` | `app.truecoach.co/proxy/api` | Bearer + `Role: Trainer` header (captured) | `clients[]` + denormalized `users[]` + `images[]`; compliance-rate decimals; workouts paginate by **date window** | **Yes** — locked 2026-06-30 | **Hand-built** (`extractors/truecoach/*`) — kept as the oracle/regression baseline | Flagship. Goal endpoint returns HTMX HTML fragment, not JSON. |
| **Trainerize** | `*.trainerize.com` (per-business subdomain) | not verified | not verified (email/password web login per docs) | not verified | No | **Inference candidate** (v0.4+) | Try the generic path first; fall back to hand-built only if inference confidence stays low. |
| **My PT Hub** | `*.mypthub.net`, `app.mypthub.net`, `mypthub.net` | not verified | not verified | not verified | No | **Inference candidate** (v0.4+) | Budget all-in-one; JSON-driven per public docs — good inference candidate. |
| **Everfit** | `app.everfit.io` (coach), `client.everfit.io` (client) | not verified | not verified (email/password web login per docs) | not verified | No | **Inference candidate** (v0.4+) | Planned first real second-platform dev capture for PR-C2 fixtures. |
| **PT Distinction** | not verified | not verified | not verified | not verified | No | **Inference candidate** (v0.4+) | Confirm host pattern before scheduling a capture session. |
| **CoachRx** | not verified | not verified | not verified | not verified | No | **Inference candidate** (v0.4+) | Named on the `_interface.js` locked-contract chef list (Chef #2). |
| **TrainHeroic** | not verified | not verified | not verified | not verified | No | **Inference candidate** (v0.4+) | Team/strength focus. |
| **FitSW** | not verified | not verified | not verified | not verified | No | **Inference candidate** (v0.4+) | candidate — verify top-10 standing before scheduling a capture. |
| **TeamBuildr** | not verified | not verified | not verified | not verified | No | **Inference candidate**, or DOM/SSR (v0.4-v0.7) | candidate — verify; may be SSR-heavy — good DOM-fallback test case. |
| **Kabata** | not verified | not verified | not verified | not verified | No | **Inference candidate** (v0.4+) | candidate — verify platform exists in target segment before scheduling. |
| **TrueCoach (WL variant)** | `*.truecoach.co` brand subdomains | same as TrueCoach | same as TrueCoach | same as TrueCoach | Yes (same backend) | **Covered by flagship** | Tier-1 cosmetic WL of the flagship — solved for free by the `*.truecoach.co` wildcard + suffix match. |

### Reading the matrix

- **"not verified"** — the cell's value is unknown. Under the current
  north star this is no longer a blocker to scheduling a build — it's the
  normal starting state for every inference candidate, since inference is
  designed to discover exactly these fields without a human verifying them
  first. It remains a hard blocker only for the **hand-built** fallback path.
- **"Inference candidate"** — default path for any JSON-driven platform;
  covered by blueprint inference + the generic replay engine once v0.4–v0.5
  ship, with no platform-specific code required.
- **"Hand-built"** — reserved for the flagship oracle and for any platform
  where inference + DOM fallback are evidenced to be insufficient. Adding a
  row to this category requires a specific rationale, not convenience.

### Host-pattern sources (public sign-in / help docs)

- Trainerize per-business subdomain: ABC Trainerize Help Center, "How to Sign
  Into Your ABC Trainerize Account" — `businessname.trainerize.com`.
- My PT Hub subdomains: My PT Hub support, "Marketing MySite FAQs" —
  `[subdomain].mypthub.net`.
- Everfit coach/client hosts: Everfit Help Center — coach web `app.everfit.io`,
  client web `client.everfit.io`.
- TrueCoach host + API: locked from live captures 2026-06-30
  (`extractors/truecoach/*` + `truecoach_samples/*`, external fixtures dir).

---

*Platform landscape corroborated across multiple 2026 buyer's-guide sources
(Trainerize Fitness Business Blog, Everfit blog, G2 Personal Training category,
TrainerFu top-10, Member Solutions guide). Host patterns cited inline above.*

---

## Version history

- **Course correction** (2026-09-09) — operator ruling: retire the
  per-platform-extractor-first cutlines (prior v0.2–v1.0 below); the generic
  site-agnostic engine (already merged) becomes the explicit north star.
  Version cutlines renumbered v0.4–v1.0 around finishing capture → inference
  → active discovery → reconstruction → fallback, in that order. See
  "North star" section above. Superseded cutlines preserved immediately below
  for audit trail only — they are no longer the plan of record.
- **Design v0.3** (2026-07-06) — mobile-app-initiated pairing flow; supersedes
  the v0.2 inline email/password model. Target `manifest.version =
  0.3.0-design`; the repo `manifest.json` is bumped from `0.2.0-design` to
  `0.3.0-design` by the v0.1 implementation PR (the design PR itself is
  docs-only). See `DESIGN.md` §2–§4 and §13.
- **Design v0.2** (2026-06-30) — inline email/password auth; dispatcher plus
  the Tier-1/Tier-2 white-label taxonomy. Retired by v0.3.

### Superseded cutlines (retired 2026-09-09 — kept for audit trail only)

<details>
<summary>Prior v0.1–v1.0 (per-platform-extractor-first framing, retired)</summary>

#### v0.1 — TrueCoach flagship + auth + progress UI  (shipped; superseded by "BUILD NEXT" above)
- TrueCoach extractor (already implemented) wired through the new dispatcher.
- Tier-1 WL subdomains (`*.truecoach.co`) via wildcard host-permission +
  `detectPlatform` suffix match.
- Pairing-code auth (`popup/pair.html`, `popup/pair.js`).
- MV3 service worker (`background.js`).
- Progress UI (`popup/popup.js`).

#### v0.2 — Custom-domain flow (Tier 2)  (retired — folded into inference path)
- `optional_host_permissions` + popup "Custom domain →" input.
- `chrome.permissions.request()` runtime grant + fingerprint probe.

#### v0.3 — Second platform + user-assisted export fallback  (retired — reordered)
- Onboard one additional top-10 platform with a verified API, hand-built.
- User-assisted export fallback.

#### v0.4 — Third + fourth platforms + per-platform rate-limit overrides  (retired — number reused above for inference)
- Two more verified platforms, hand-built.
- Per-platform `RATE_LIMIT_MS` overrides.

#### v0.5 — Fifth through eighth platforms  (retired — number reused above)
- Four more verified platforms, hand-built.

#### v0.9 — Top 10 covered  (retired — number reused above with inference-first framing)
- Remaining top-10 platforms onboarded (each API-verified) or covered by
  export fallback.

#### v1.0 — BYO-extractor SDK  (retired — number reused above, same idea kept)
- Public `_interface.js` as an NPM package.
- Signed side-load path for third-party extractors.

</details>
</content>
