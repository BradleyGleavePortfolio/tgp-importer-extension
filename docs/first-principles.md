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
   *Design consequence:* refresh token in `chrome.storage.session` (survives a
   service-worker restart within a browser session, but is cleared on browser
   restart → intentional re-pair); access token rehydrated in memory on wake
   (DESIGN §4). No secret is ever written to `chrome.storage.local`.

2. **Cross-device identity bridge is a short-lived server-minted secret** — a
   desktop Chrome extension and a mobile-native app share no origin, cookies,
   or runtime messaging channel. Every mainstream cross-device sign-in flow
   (TV app pairing, GitHub CLI device flow, Netflix / Spotify TV login) uses
   the same primitive: a backend mints a short-TTL code, the mobile side
   displays it, the second device redeems it. RFC 8628 (OAuth 2.0 Device
   Authorization Grant) is the standards-track expression of this pattern.
   *Source:* IETF RFC 8628 — https://datatracker.ietf.org/doc/html/rfc8628
   *Design consequence:* the extension's only path to a token is
   `POST /api/extension/pair/redeem`; there is no inline login (DESIGN §2, §4).

3. **Per-site rate limits** — the source platform enforces request-rate limits;
   exceeding them risks throttling or account flags.
   *Source:* platform Terms of Service acceptable-use clauses (per-platform —
   TrueCoach ToS §acceptable-use; re-cite per platform as onboarded). The
   `net.js` `RATE_LIMIT_MS = 500` value is our conservative self-limit, not a
   published number.
   *Design consequence:* honour `RATE_LIMIT_MS`; per-platform override.

4. **Locked `_interface.js` contract (v0)** — the entity envelope is fixed.
   *Source:* internal — `extractors/_interface.js` header + operator lock.
   *Design consequence:* changes require an operator ruling; every extractor
   and the backend ingest shape depend on it.

5. **Cross-origin fetch privileges (no backend CORS needed)** — extensions with
   host permissions bypass page-origin CORS for those origins.
   *Source:* Chrome cross-origin XHR / host-permissions docs —
   https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
   and the CORS model in RFC 6454 (Web Origin Concept).
   *Design consequence:* backend need not relax CORS for the extension.

6. **MV3 Content Security Policy — no inline/remote code** — MV3 forbids inline
   script, `eval`, and remotely hosted code; all logic must be packaged static
   files.
   *Source:* Chrome MV3 CSP / "Improving extension security" docs —
   https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
   and https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
   *Design consequence:* no dynamic script injection; every module is a static
   file listed in the manifest.

7. **Cookies API permission** — reading another origin's cookies requires the
   `cookies` permission plus host access.
   *Source:* Chrome `chrome.cookies` API reference —
   https://developer.chrome.com/docs/extensions/reference/api/cookies
   *Design consequence:* `cookies` permission is NOT declared (least privilege; in-tab credentials:include is used) — historical note: was once
   `manifest.json`.

---

## Assumptions — R131 challenge triggers (DESIGN §8)

1. **6-digit numeric pairing codes with a ~2-minute TTL are acceptable UX.**
   The mobile app displays the code; the coach types it into the desktop
   popup within the TTL. Length and TTL are backend policy settings and can
   be tuned server-side without touching the extension.
   *Trigger:* re-verify at first external coach pilot, or 2026-12-31,
   whichever is sooner. If field data shows a material mistype rate or TTL
   expiry rate, tune length (up to 8 digits) and/or TTL (up to 5 minutes)
   first; only if UX still fails, add the deferred QR-code fallback in the
   mobile app. If pairing itself is rejected as a mechanism, swap to a full
   OAuth device-flow (RFC 8628) — the extension side change is minimal
   because the token-storage layer is unchanged.

2. **TrueCoach REST API is stable.**
   *Trigger:* quarterly re-capture per R131. Locked 2026-06-30 → next trigger
   **2026-09-30**. Any shape drift invalidates `truecoach_samples/*` fixtures.

3. **Backend exposes `/api/extension/pair/*` and `/auth/extension/refresh`.**
   *Trigger:* re-verify before v0.1 code-complete. `POST /auth/extension/
   refresh` was delivered by IMPORTER-A (`growth-project-backend` PR #496,
   merged 2026-07); the three pairing endpoints (`pair/init`, `pair/status`,
   `pair/redeem`) are **not yet built** and block end-to-end pairing until
   delivered. `POST /api/scout/ingest`, `POST /api/scout/progress`, and
   `POST /api/scout/ingest/complete` are additional TGP-side dependencies
   flagged in DESIGN §Backend dependencies.

### Retired assumptions

- **~~Coaches accept inline email/password.~~** *Retired 2026-07-06 by the
  mobile-app-initiated pairing ruling (DESIGN v0.3 §2, §3, §4).* The extension
  no longer has an inline login surface, so the assumption no longer applies.
  Left here as a historical marker per R130 (chosen-not-forced): the shift
  from inline login to pairing was a chosen response to TGP being a
  mobile-only app, not a platform-imposed constraint.

---

*This file is intentionally short. It exists to keep DESIGN's constraint/
assumption split honest and sourced, per R130/R136.*
