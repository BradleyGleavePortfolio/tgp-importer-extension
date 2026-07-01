# TGP Importer — First Principles (R136 companion)

This doc frames the extension design against doctrine R130–R137. It is the
sourcing layer for `DESIGN.md`: every **hard constraint** (DESIGN §7) cites its
authority, and every **assumption** (DESIGN §8) carries an R131 challenge
trigger.

Doctrine anchors used here:
- **R130** — separate what is forced by the platform from what we chose.
- **R131** — every assumption is time-boxed and re-verified on a trigger.
- **R136** — hard constraints are non-negotiable and must be sourced; soft
  assumptions must be labelled challengeable.
- **R137** — degrade gracefully; never let a constraint become total failure
  (drives the user-assisted export fallback).

---

## Hard constraints — sources (DESIGN §7)

1. **Chrome MV3 service-worker lifecycle** — a background service worker can be
   terminated at any time and has no persistent globals across restarts.
   *Source:* Chrome Extensions MV3 service-worker lifecycle docs —
   https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
   *Design consequence:* refresh token in `chrome.storage.local`; access token
   rehydrated on wake (DESIGN §4).

2. **Per-site rate limits** — the source platform enforces request-rate limits;
   exceeding them risks throttling or account flags.
   *Source:* platform Terms of Service acceptable-use clauses (per-platform —
   TrueCoach ToS §acceptable-use; re-cite per platform as onboarded). The
   `net.js` `RATE_LIMIT_MS = 500` value is our conservative self-limit, not a
   published number.
   *Design consequence:* honour `RATE_LIMIT_MS`; per-platform override.

3. **Locked `_interface.js` contract (v0)** — the entity envelope is fixed.
   *Source:* internal — `extractors/_interface.js` header + operator lock.
   *Design consequence:* changes require an operator ruling; every extractor
   and the backend ingest shape depend on it.

4. **Cross-origin fetch privileges (no backend CORS needed)** — extensions with
   host permissions bypass page-origin CORS for those origins.
   *Source:* Chrome cross-origin XHR / host-permissions docs —
   https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
   and the CORS model in RFC 6454 (Web Origin Concept).
   *Design consequence:* backend need not relax CORS for the extension.

5. **MV3 Content Security Policy — no inline/remote code** — MV3 forbids inline
   script, `eval`, and remotely hosted code; all logic must be packaged static
   files.
   *Source:* Chrome MV3 CSP / "Improving extension security" docs —
   https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
   and https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
   *Design consequence:* no dynamic script injection; every module is a static
   file listed in the manifest.

6. **Cookies API permission** — reading another origin's cookies requires the
   `cookies` permission plus host access.
   *Source:* Chrome `chrome.cookies` API reference —
   https://developer.chrome.com/docs/extensions/reference/api/cookies
   *Design consequence:* `cookies` permission already declared in
   `manifest.json`.

---

## Assumptions — R131 challenge triggers (DESIGN §8)

1. **Coaches accept inline email/password.**
   *Trigger:* re-verify at first external coach pilot, or 2026-12-31, whichever
   is sooner. If rejected, swap to OAuth — contract-safe (only `login.*` +
   `/auth/extension/*` change).

2. **TrueCoach REST API is stable.**
   *Trigger:* quarterly re-capture per R131. Locked 2026-06-30 → next trigger
   **2026-09-30**. Any shape drift invalidates `truecoach_samples/*` fixtures.

3. **Backend exposes `/auth/extension/*`.**
   *Trigger:* re-verify before v0.1 code-complete. Currently **not built** —
   this is a TGP-side dependency and blocks end-to-end login until delivered.

---

*This file is intentionally short. It exists to keep DESIGN's constraint/
assumption split honest and sourced, per R130/R136.*
