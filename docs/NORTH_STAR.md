# TGP Importer — North Star (the only one)

Owner: Bradley Gleave. Effective 2026-09-27. This supersedes every earlier importer mission, roadmap, platform matrix and plan.
Where anything conflicts with this page, this page wins.

## The product
A coach says **"this is where my business lives"** (any coaching site, including one TGP has never seen).
They authorize it and press **Start once**. TGP then:
1. **Decodes** the site's data structure, with AI assistance.
2. **Learns** the structure as data (never code), checked by strict deterministic validators.
3. **Imports** the coach's business into native TGP records.
4. **Verifies** the result and reports the truth: `complete` only when proven, otherwise an honest `partial` or `failed`, with reasons.
5. **Remembers** what it learned (structure only, never client data or secrets). The next coach on that site starts instantly.
   Drift is detected and the structure is re-learned automatically.

Zero routine coach actions after Start. No human ever writes platform-specific work again.

## Invariants
- **NEW SOURCE → CORE DIFF = 0.** A new site needs no code change, no deploy and no per-platform file written by a person.
- **No vendor names in core code.** No per-vendor extractors, host lists, endpoint maps or `if platform === …` branches.
- **AI returns data only.** It never produces executable code and never invents write actions. Source behaviour is read-only.
- **Deterministic software owns** identity, execution, origin confinement, writes, reconstruction, reconciliation, lifecycle and terminal truth.
  AI never decides `complete`.
- **Credentials are capabilities, not data.** They are never stored, never learned and never sent to a model.

## The coach experience: Roman
The coach-facing journey is the **Roman importer journey** in mobile (`src/screens/coach/import-journey/`, Roman on/off, neutral by default).
The steps are: pick or enter the site → authorize → Start → live progress → the truthful verdict. The extension popup is a status surface only.
Every importer UX change follows the Roman journey.

## What this retires
- "TrueCoach importer" framing, everywhere.
- Per-platform extractors and hand-written platform mappings. The existing TrueCoach extractor and `truecoach.json` are
  **quarantined legacy oracles**: they exist only to check that the learned path matches them. They are deleted when the learned path proves
  parity (the V1 exit).
- Learn/Confirm or any other manual coach step, the platform matrix, per-platform "export recipes" as the product, and the BYO-extractor SDK.

## How it is enforced
- A **vendor-name guard** in CI in every importer repo. Core paths must contain no competitor names.
  Allowed: tests and fixtures, the quarantined legacy directories (a ratchet that only shrinks), mobile's source-picker shortcuts (data), historical records.
- Every slice grant cites this page. Any slice that adds vendor-specific behaviour is rejected at review as a class-A finding.
