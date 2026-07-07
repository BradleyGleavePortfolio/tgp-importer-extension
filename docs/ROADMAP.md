# TGP Importer — Roadmap & Platform Matrix

Companion to `DESIGN.md`. This document holds (a) the per-platform coverage
matrix and (b) the version cutlines. It is deliberately conservative: where a
platform's API base, auth mechanism, or client-model shape has **not** been
confirmed from a live capture, the cell reads **"not verified"** and must not
be treated as real until a capture exists. **No API endpoint in this file is
invented.**

---

## Platform matrix

Rows are the target top-10 coaching platforms. TrueCoach is the flagship and is
the only platform whose shapes are locked from live captures (2026-06-30). The
others are prioritisation targets: their host patterns are drawn from public
sign-in/help documentation (cited below), but their **API bases, auth
mechanisms, and client-model shapes are NOT yet verified** and are marked as
such. Several rows are marked **"candidate — verify"** where top-10 standing or
platform structure still needs confirmation.

| Platform | Tier-1 host pattern | API base | Auth mechanism | Client model shape | Verified from live capture? | Extractor status | Notes |
|---|---|---|---|---|---|---|---|
| **TrueCoach** | `*.truecoach.co`, `app.truecoach.co` | `app.truecoach.co/proxy/api` | Bearer + `Role: Trainer` header (captured) | `clients[]` + denormalized `users[]` + `images[]`; compliance-rate decimals; workouts paginate by **date window** | **Yes** — locked 2026-06-30 | **Implemented** (`extractors/truecoach/*`) | Flagship. Goal endpoint returns HTMX HTML fragment, not JSON. |
| **Trainerize** | `*.trainerize.com` (per-business subdomain) | not verified | not verified (email/password web login per docs) | not verified | No | Stub (`// v0.3`) | Per-business subdomain is a textbook Tier-1 cosmetic WL. High-value; large install base. |
| **My PT Hub** | `*.mypthub.net`, `app.mypthub.net`, `mypthub.net` | not verified | not verified | not verified | No | Stub (`// v0.3`) | Brand subdomains documented (`[subdomain].mypthub.net`). Budget all-in-one. |
| **Everfit** | `app.everfit.io` (coach), `client.everfit.io` (client) | not verified | not verified (email/password web login per docs) | not verified | No | Stub (`// v0.3`) | Coach web app at `app.everfit.io`. Strong 2026 review standing. |
| **PT Distinction** | not verified | not verified | not verified | not verified | No | Stub (`// v0.3`) | Nutrition-led / workout-first coaching. Confirm host pattern before build. |
| **CoachRx** | not verified | not verified | not verified | not verified | No | Stub (`// v0.3`) | Named on the `_interface.js` locked-contract chef list (Chef #2). |
| **TrainHeroic** | not verified | not verified | not verified | not verified | No | Stub (`// v0.3`) | Team/strength focus; appears on multiple 2026 top-software lists. |
| **FitSW** | not verified | not verified | not verified | not verified | No | Stub (`// v0.3`) | candidate — verify top-10 standing before scheduling. |
| **TeamBuildr** | not verified | not verified | not verified | not verified | No | Stub (`// v0.3`) | candidate — verify. Strength & conditioning / team market; may not be top-10 for the individual-coach segment. |
| **Kabata** | not verified | not verified | not verified | not verified | No | Stub (`// v0.3`) | candidate — verify. Confirm the platform exists in the target segment and its host pattern before scheduling. |
| **TrueCoach (WL variant)** | `*.truecoach.co` brand subdomains | same as TrueCoach | same as TrueCoach | same as TrueCoach | Yes (same backend) | **Covered by flagship** | Tier-1 cosmetic WL of the flagship — solved for free by the `*.truecoach.co` wildcard + suffix match. Not a separate build. |

### Reading the matrix

- **"not verified"** — the cell's value is unknown and must be confirmed from a
  live capture (or first-party API docs) before any extractor code is written.
  Do **not** ship an extractor that guesses these.
- **"candidate — verify"** — the platform's inclusion in the genuine top-10 for
  TGP's target segment (individual/online fitness coaches) is not yet
  confirmed; validate demand before committing a version slot.
- **"Covered by flagship"** — no separate build; a Tier-1 wildcard + suffix
  match handles it.

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

## Version cutlines

### v0.1 — TrueCoach flagship + auth + progress UI  ← **BUILD NEXT**
- TrueCoach extractor (already implemented) wired through the new dispatcher.
- Tier-1 WL subdomains (`*.truecoach.co`) via wildcard host-permission +
  `detectPlatform` suffix match.
- Pairing-code auth (`popup/pair.html`, `popup/pair.js`) — the
  mobile-app-initiated pairing flow is the **only** token path (operator ruling
  2026-07-06). See `DESIGN.md` §2–§4 and the pairing security model in §13.
  There is **no inline email/password login**; `/auth/extension/refresh`
  remains for token rotation only.
- MV3 service worker (`background.js`) — token lifecycle, extractor dispatch,
  ingest forwarding, completion notification.
- Progress UI (`popup/popup.js`, already implemented).

### v0.2 — Custom-domain flow (Tier 2)
- `optional_host_permissions` + popup "Custom domain →" input.
- `chrome.permissions.request()` runtime grant + fingerprint probe to select
  the extractor for a domain-fronted origin.

### v0.3 — Second platform + user-assisted export fallback
- Onboard **one** additional top-10 platform **with a verified API** (chosen
  from the matrix once its API base / auth / model are captured — do not pick
  a "not verified" row until it is verified).
- User-assisted export fallback (§6 of `DESIGN.md`) for platforms we cannot
  crawl — first `docs/export-recipes/<platform>.md` authored here.

### v0.4 — Third + fourth platforms + per-platform rate-limit overrides
- Two more verified platforms.
- Per-platform `RATE_LIMIT_MS` overrides plumbed through the dispatcher.

### v0.5 — Fifth through eighth platforms
- Four more verified platforms.

### v0.9 — Top 10 covered
- Remaining top-10 platforms onboarded (each API-verified) or explicitly
  covered by the export fallback where no API access exists.

### v1.0 — BYO-extractor SDK
- Public `_interface.js` as an NPM package.
- Signed side-load path so third parties can ship long-tail extractors against
  the locked contract without a core release.

---

*Platform landscape corroborated across multiple 2026 buyer's-guide sources
(Trainerize Fitness Business Blog, Everfit blog, G2 Personal Training category,
TrainerFu top-10, Member Solutions guide). Host patterns cited inline above.*

---

## Version history

- **Design v0.3** (2026-07-06) — mobile-app-initiated pairing flow; supersedes
  the v0.2 inline email/password model. Target `manifest.version =
  0.3.0-design`; the repo `manifest.json` is bumped from `0.2.0-design` to
  `0.3.0-design` by the v0.1 implementation PR (the design PR itself is
  docs-only). See `DESIGN.md` §2–§4 and §13.
- **Design v0.2** (2026-06-30) — inline email/password auth; dispatcher plus
  the Tier-1/Tier-2 white-label taxonomy. Retired by v0.3.
