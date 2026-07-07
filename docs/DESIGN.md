# TGP Importer — Design v0.3

> Status: **design** (pre-release, `manifest.version = 0.3.0-design`).
> Supersedes v0.2 (2026-06-30 inline email/password model). Locked by operator
> ruling on 2026-07-06 (mobile-app-initiated pairing flow — TGP is a mobile app,
> not a web app, so the desktop popup can no longer carry the login surface).
> This document is the single source of truth for what v0.1 builds and what
> later versions defer to (see `ROADMAP.md`). First-principles / doctrine
> framing lives in `first-principles.md`.

---

## 1. Goal

Site-agnostic import into TGP. A coach initiates the import from the **TGP
mobile app**, installs the desktop Chrome extension, pairs the two with a
short-lived code, and the extension pulls their entire client roster, programs,
library, and history out of whatever coaching platform they currently use —
without TGP ever holding that platform's credentials, and without the coach
doing manual CSV surgery.

- **Concrete milestone:** the top-10 coaching platforms supported end-to-end
  (roster → programs → library → per-client history), driven from the same
  locked entity envelope (`extractors/_interface.js`) and the same TGP ingest
  endpoint. The prioritised platform list and per-platform status live in
  `ROADMAP.md`.
- **Long tail:** platforms outside the top-10 are covered by a
  **BYO-extractor SDK** (public `_interface.js` package + signed side-load),
  scheduled for v1.0. Until then, any platform we cannot reach programmatically
  falls back to the **user-assisted export** path (§6) so no coach is ever
  fully blocked.

The flagship (v0.1) platform is TrueCoach, which is already implemented as a
fully autonomous API walk under `extractors/truecoach/*`. Everything in this
design generalises that pattern to a dispatcher (`detectPlatform`) + a
per-platform extractor class behind the locked interface.

---

## 2. User flow (mobile-app-initiated — locked by operator 2026-07-06)

This is the canonical flow. Do not deviate without an operator ruling. The flow
is deliberately **cross-device**: TGP identity lives on the coach's phone, the
crawl happens in desktop Chrome, and a short-lived pairing code is the only
bridge between them. There is **no inline email/password** anywhere in the
extension popup.

1. **"Import your data" CTA** inside the TGP mobile app. The coach is already
   authenticated in TGP on their phone; no re-auth is required for TGP identity.
2. **"Download extension" screen.** The mobile app renders a Chrome Web Store
   deep link plus a short URL the coach can type on their laptop. A QR code
   variant is deferred (see §8 assumptions). In-app native install prompts and
   self-hosted CRX distribution are out of scope for v0.1.
3. **Progress screen** on the mobile app, following the TGP mobile design
   system. The mobile app polls `GET /api/extension/pair/status?code=...`
   waiting for the pairing signal.
4. **"Choose your previous site"** page on the mobile app. The coach selects
   the source platform (TrueCoach, Trainerize, My PT Hub, etc. — driven by the
   `ROADMAP.md` matrix). This selection is stored server-side against the
   pairing code so the extension knows which platform to target the moment it
   redeems.
5. **Pairing code display.** The mobile app calls
   `POST /api/extension/pair/init` with `{ chosen_platform }`. The backend
   returns `{ pairing_code, expires_at }` — a **6-digit numeric code** with a
   **short TTL** (nominal 2 minutes; exact TTL is a backend policy setting).
   The mobile app displays the code in the luxury mobile design pattern
   (large mono digits, copy-to-clipboard). QR-code display is deferred.
6. **Install & open the extension** on desktop. On first run (no valid session
   in `chrome.storage.local`) the popup renders the **pairing view**
   (`popup/pair.html` / `popup/pair.js`): a single 6-digit input with
   auto-focus and paste support. No email, no password, no signup link.
7. **Redeem the pairing code.** Submitting the code issues
   `POST https://api.tgp.coach/api/extension/pair/redeem` with `{ code }`. The
   backend, if the code is unexpired and unused, returns
   `{ access_token, refresh_token, chosen_platform }` bound to the coach's
   TGP account. Both tokens are stored per §4 (refresh in
   `chrome.storage.local`, access in memory only). The chosen platform is
   stored in `chrome.storage.local` under `session.chosenPlatform` so the
   popup can render the platform-specific CTA on next open.
8. **Auto-open source platform + popup fires.** With pairing complete, the
   background worker opens the source-platform URL in a new tab
   (`chrome.tabs.create({ url: platformHomeUrl(chosenPlatform) })`) and the
   popup opens on that tab. If the coach is already logged into that source
   platform in Chrome, no further auth is required; otherwise the coach
   logs into the source platform in that tab as themselves. The extension
   reuses that logged-in session (cookies + bearer captured in-tab) — **TGP
   never sees the source platform's credentials.**
9. **"Transfer data? ETA ~2 min" CTA** in the popup. Single primary button.
   Clicking sends `{ kind: "start_ingest", ... }` to the background service
   worker. The worker starts the matched extractor. The extraction is a
   **fully autonomous API walk** — no tab navigation beyond the initial open,
   no DOM scripting, no user babysitting.
10. **Progress mirrored on both devices.** The worker broadcasts a
    `status_snapshot` on every batch commit; the popup renders per-entity
    progress bars (unchanged from earlier versions — `popup/popup.js`
    `renderProgress`). It additionally posts the same snapshot to
    `POST /api/scout/progress` so the mobile app's progress screen can update
    via its existing poll/socket path. Cross-device progress mirroring is a
    hard requirement of the mobile-first UX.
11. **Completion.** On finish, the worker fires a
    `chrome.notifications.create` toast on desktop and posts a terminal
    `POST https://api.tgp.coach/api/scout/ingest/complete` so the backend can
    flip the import to a settled state and push a completion notification to
    the mobile app.

---

## 3. Account binding — the token IS the binding

The bearer token issued in step 7 **is** the account binding. Every ingest
call the background worker makes carries:

```
Authorization: Bearer <extension_access_token>
```

The backend routes the payload to the correct TGP account **by token
identity** — it derives the coach/org from the token, not from any request
body field or cross-tab handshake. There is nothing to reconcile client-side.

### Pairing produces the token; nothing else does

In v0.3 there is exactly one path from "no session" to "have session":
`POST /api/extension/pair/redeem`. There is no inline login, no OAuth
redirect, no signup link in the popup. If a coach doesn't have a TGP account
yet, they create it inside the mobile app (which owns onboarding, email
verification, and terms acceptance) and then start the import flow from there.

### This replaces both the `INTENT_QUERY_PARAM` handshake and the v0.2 inline login

The Day-1 build used a **TGP-initiated** handshake via a `?tgp_intent=<id>`
query param on the source-platform URL (`INTENT_QUERY_PARAM` in
`shared/protocol.js`). The v0.2 build replaced that with an
**extension-initiated** inline login form. Neither works cross-device: TGP is
a mobile app and cannot open a desktop tab with a query param, and the
desktop popup cannot host TGP account creation without duplicating mobile-side
onboarding.

The v0.3 flow is **mobile-initiated, extension-executed, backend-brokered**:
- The mobile app declares intent and platform choice.
- The backend mints a pairing code bound to both.
- The extension redeems the code for a token bound to the same coach.
- The token thereafter carries identity.

The `INTENT_QUERY_PARAM` / `STORAGE_KEY_INTENT` constants remain in
`shared/protocol.js` for backwards compatibility during migration, but the
v0.3 flow does not depend on them. They should be removed in a later cleanup
once no legacy imports remain in flight. The v0.2 `popup/login.html` and
`popup/login.js` files are superseded by `popup/pair.html` and
`popup/pair.js`; the login files should be deleted in the v0.3 build.

---

## 4. Auth model

- **Pairing-code redemption** (operator ruling 2026-07-06). The extension has
  no login form. Its only path to a token is
  `POST /api/extension/pair/redeem { code }`, and the code is minted by the
  mobile app via `POST /api/extension/pair/init`. Codes are 6-digit numeric,
  short-TTL (nominal 2 minutes), single-use, and bound to the coach's TGP
  account plus the chosen source platform at mint time.
- **Token pair** (unchanged from v0.2).
  - `POST /api/extension/pair/redeem` → `{ access_token, refresh_token,
    chosen_platform, ... }` on the initial pair.
  - `POST /auth/extension/refresh` → new access token (and optionally a
    rotated refresh token) given a valid refresh token. Used for **token
    rotation** and to recover from a 401 mid-crawl.
- **Storage rules (MV3-aware, unchanged from v0.2).**
  - The **refresh token** is persisted in `chrome.storage.local`.
  - The **access token** is kept **in memory only** — in a background
    worker-scoped variable. It is **never** written to `chrome.storage.session`
    or `.local`. Rationale: an MV3 service worker is killed frequently and
    unpredictably; treating the access token as ephemeral avoids leaving a
    live bearer at rest.
  - **On service-worker wake**, the worker has no in-memory access token. It
    **rehydrates** by reading the refresh token from `chrome.storage.local` and
    calling `/auth/extension/refresh` to mint a fresh access token on demand
    (lazily, on the first call that needs it).
  - If refresh itself returns 401, the worker clears both tokens and broadcasts
    `auth_required`; the popup then falls back to the pairing view. The coach
    re-initiates from the mobile app to get a new pairing code.
- **Chosen platform storage.** `session.chosenPlatform` is persisted in
  `chrome.storage.local` at redeem time. It survives service-worker deaths and
  is the input to `platformHomeUrl(...)` when the worker opens the source-
  platform tab in step 8.

---

## 5. White-label taxonomy (three tiers)

Coaching platforms resell themselves under coach/gym brands in three
structurally different ways. The extension's coverage strategy differs per
tier. This section is **unchanged from v0.2** — pairing does not affect how
the extension recognises source platforms.

### Tier 1 — Cosmetic white-label

The platform hosts everything; the coach only gets a **brand subdomain**
(e.g. `theirbrand.truecoach.co`, `theirbusiness.trainerize.com`). The API,
DOM, and auth are identical to the flagship host — only the hostname prefix
changes.

- **Coverage:** *free.* A **wildcard host-permission**
  (`*://*.truecoach.co/*`) plus `detectPlatform(url)` matching on the hostname
  **suffix** picks the right extractor regardless of the brand prefix.
- **Per-brand effort:** **zero.** No new manifest entry, no new code per brand.

### Tier 2 — Domain-fronted white-label

The coach owns a real domain (e.g. `app.coachbrand.com`) whose DNS points at
the platform. Same backend, **different origin** — so a static wildcard cannot
enumerate it (we cannot list every coach's vanity domain in the manifest, and
`<all_urls>` at install time is a permission the store would reject for a
narrow importer).

- **Coverage:** `optional_host_permissions` + a popup **"Custom domain →"**
  input. The coach types their vanity domain; the extension calls
  `chrome.permissions.request()` for that specific origin (a runtime grant, not
  an install-time one), then **probes a fingerprint endpoint** on that origin
  to decide which extractor drives it.
- **Ships in:** v0.2.

### Tier 3 — Truly custom app

The coach runs a bespoke app (custom Firebase / Supabase / hand-rolled
backend). There is **no shared API or DOM** to target, so no extension coverage
is possible.

- **Coverage:** none at the extension level. Fallback is the **user-assisted
  export** path (§6). A **direct-DB migration** is offered as a *services*
  engagement (runbook only — **out of product scope**, not shipped in the
  extension).

---

## 6. User-assisted export fallback

When the extension cannot reach a platform's backend — Tier 3, an unsupported
platform, or a crawl blocked by the platform — it degrades gracefully instead
of failing. This section is **unchanged from v0.2**.

1. The popup surfaces a **per-platform export walkthrough**, sourced from
   `docs/export-recipes/<platform>.md` (this directory ships empty in v0.3
   with a single `.gitkeep`; recipes are authored as platforms are onboarded).
2. The coach performs the platform's **native export** (CSV / PDF / JSON) and
   **uploads the file(s)** to the extension.
3. The extension **parses the uploaded file** through the **same locked entity
   envelope** (`makeEntity` / `_interface.js`) and calls the **same
   `POST /api/scout/ingest`** endpoint as an autonomous crawl would.

Because the envelope and the ingest endpoint are identical, the backend cannot
tell (and does not care) whether entities arrived via crawl or via upload.
This guarantees **no coach ever loses their programs**, even on platforms we
cannot reach programmatically.

---

## 7. Hard constraints (R136 compliance)

These are **non-negotiable** design constraints. Each is sourced in
`first-principles.md`.

- **Chrome MV3 sandbox.** The background is a **service worker** that can be
  **terminated at any time**. There are **no persistent globals** across SW
  deaths. Any state that must survive a wake (the refresh token, the chosen
  platform, the progress snapshot schema) lives in `chrome.storage.local`;
  the access token is rehydrated via `/auth/extension/refresh` on wake (§4).
- **Cross-device identity bridge is a short-lived server-minted secret.**
  A desktop Chrome extension and a mobile-native app share no origin, no
  cookies, no runtime messaging channel. The only cross-device bridge that
  does not require typing a password is a backend-brokered pairing code with
  a short TTL. This is the same primitive used by TV-app sign-ins across the
  industry; it is not a novel invention.
- **Per-site rate limits.** Respect the TrueCoach limiter (`net.js`
  `RATE_LIMIT_MS = 500`, ~2 req/s). Each platform gets its own override
  constant; the dispatcher passes the platform's rate to its extractor.
- **Locked `_interface.js` contract (v0).** The entity envelope and
  `makeEntity` signature are **locked**. They cannot change without an operator
  ruling because every downstream extractor (and the backend ingest shape)
  depends on them.
- **Cross-origin CORS.** The extension has **full-origin fetch privileges** for
  any origin listed in `host_permissions` (or granted at runtime via
  `optional_host_permissions`). It therefore does **not** need the backend to
  relax CORS — extension fetches are not subject to page-origin CORS.
- **Content Security Policy.** MV3 forbids inline `eval` and inline script.
  **All JS must be static files.** No dynamic script injection, no
  `new Function`, no remote code. Every module in this repo is a static file
  loaded by the manifest.
- **Cookies API.** Reading the source platform's session cookie (e.g. the
  TrueCoach session) requires the `cookies` permission — **already present** in
  `manifest.json`.

---

## 8. Assumptions (R136 — challengeable, not hard)

These are working assumptions that could change without breaking the locked
contract. Each carries an R131 re-verification trigger (see
`first-principles.md`).

- **6-digit numeric codes with a ~2-minute TTL are acceptable UX.** If field
  data shows coaches mistyping codes or the TTL expiring before they finish
  installing the extension, the code length (up to 8 digits) or TTL (up to 5
  minutes) can be tuned server-side without touching the extension. QR-code
  display in the mobile app is a deferred fallback that would require the
  desktop machine to have a webcam or the coach to use their phone as a
  scanner — deliberately punted to a later release.
- **The TrueCoach REST API is stable.** Shapes are locked from **live
  captures on 2026-06-30**. Re-verify quarterly per R131 (next trigger:
  2026-09-30).
- **The backend exposes `/api/extension/pair/*` and `/auth/extension/refresh`.**
  These endpoint groups are **not yet built** in full — they are a **TGP-side
  dependency** (see §Backend dependencies). Until they exist, the pairing flow
  cannot complete end-to-end. `POST /auth/extension/refresh` was delivered by
  IMPORTER-A (#496 in `growth-project-backend`, merged 2026-07); the pairing
  endpoints are new work.
- **The inline email/password assumption from v0.2 is retired.** DESIGN.md
  v0.2 §8 listed *"coaches accept inline email/password"* as a challengeable
  assumption. v0.3 removes the inline login surface entirely, so the
  assumption no longer applies and its R131 trigger is closed.

---

## 9. Per-entity extractor pipeline

The extractor walks entities in a fixed order; the ordering rationale is stated
in `extractors/truecoach/identity.js`. This section is **unchanged from v0.2** —
pairing does not affect what the extractor walks or in what order.

1. **Identity** — `GET /organizations` first, so the run learns the current
   `trainerId` + `orgId`. Those ids gate the exercise-ownership filter
   (`library.js` `ownsExercise`) and are stamped as provenance onto **every**
   later entity (`identity.js` `stampProvenance`). The trainer entity is
   emitted first so the backend can attach every later entity to a known coach
   row.
2. **Clients** — paginated roster (`parse.js` `parseClientsPage`,
   `buildClientEntity`), joined with `users[]` + avatar images
   (`indexImagesByParent`) + compliance rates.
3. **Workouts** — per-client, walked by **date window** (not page number) via
   `net.js` `buildDateWindows` / `workoutsPath`, joined with `workout_items`
   (`parse.js` `buildWorkoutEntities`). Includes nutrition plans, weight
   tracking, assessments, notes, and the HTML-fragment **goal** endpoint
   (`goal.js`).
4. **Library** — org-scoped exercises (owned-only filter), warmups, cooldowns,
   programs, skeletons (`library.js`), streamed in `EXERCISE_CHUNK`-sized
   batches.
5. **Goals** — the per-client goal fragment (HTMX HTML, parsed via `DOMParser`
   in `goal.js`), emitting zero entities when all macros are unset.

The orchestrator (`extractors/truecoach/extractor.js`) composes these in order,
calling `sendEntities` per batch and `broadcastStatus` after each commit.

---

## 10. Progress protocol

- The extractor is constructed with an injected `broadcastStatus(snapshot)`.
- On **every batch commit**, the worker calls `chrome.runtime.sendMessage` with
  a `{ kind: "status_snapshot", intent, progress: [...], lastError }` message.
- The popup (`popup/popup.js`) subscribes via
  `chrome.runtime.onMessage.addListener` and re-renders per-entity progress
  bars. It also requests the current snapshot on open with
  `{ kind: "request_status" }`.
- **New in v0.3:** on every commit the worker also POSTs the snapshot to
  `POST /api/scout/progress` so the TGP mobile app can mirror progress on its
  in-app progress screen. Snapshot shape is unchanged; the backend echoes it
  through to the mobile app's existing poll/socket path.
- Snapshot shape is owned by the background worker and is the same object the
  popup already renders — this design does not change it.

---

## 11. Testing

- **Pure parsers** in `extractors/truecoach/parse.js` (and the other pure
  modules) are unit-tested directly against **recorded fixtures**. The locked
  response shapes live in `truecoach_samples/*.json`. **Note:** that fixtures
  directory is **not part of this repo** — it is an external dependency of the
  test harness (flagged so the operator can wire it into CI).
- **Integration tests** drive the extractor class with injected
  `sendEntities` / `broadcastStatus` spies and a **fixed `now`** clock (so
  `net.js` `buildDateWindows` is deterministic), replaying recorded fixtures
  through the same code path the runtime uses.
- **New in v0.3:** `popup/pair.js` is unit-tested with a mocked fetch against
  a fixture for `POST /api/extension/pair/redeem`. Success returns a token
  bundle and drives the popup into the "chosen platform" view; failure
  (expired code, already-used code, wrong code) drives the popup back to the
  6-digit input with the appropriate error string. No test may reach the
  live network.
- No test may reach the live network; the `now` injection and fixture replay
  keep runs hermetic.

---

## 12. What ships in v0.1 vs later

Full matrix in `ROADMAP.md`. Summary:

- **v0.1 (build next):** TrueCoach flagship + Tier-1 WL subdomains, pairing-
  code UI (`popup/pair.html` / `popup/pair.js`), MV3 service worker,
  autonomous crawl, progress UI (with mobile mirroring via
  `/api/scout/progress`), completion notification.
- **v0.2:** Tier-2 custom-domain flow (`optional_host_permissions` +
  fingerprint probe).
- **v0.3+:** additional platforms (one at a time, API-verified) and the
  user-assisted export fallback for platforms we cannot crawl.
- **v1.0:** BYO-extractor SDK.

---

## Backend dependencies (flag for operator — create TGP-side tickets)

- **`POST /api/extension/pair/init`** — mobile app calls with
  `{ chosen_platform }`; returns `{ pairing_code, expires_at }`. Codes are
  6-digit numeric, short-TTL (nominal 2 minutes), single-use, and bound to
  the coach's TGP account + chosen platform at mint time. **Not yet built.**
- **`GET /api/extension/pair/status?code=…`** — mobile app polls; returns
  `pending | paired | expired`. **Not yet built.**
- **`POST /api/extension/pair/redeem`** — extension calls with `{ code }`;
  returns `{ access_token, refresh_token, chosen_platform }` on success, or
  a structured error (`expired`, `already_used`, `invalid`) on failure.
  **Not yet built.**
- **`POST /auth/extension/refresh`** — refresh token → new access token (+
  optional rotated refresh). Delivered by IMPORTER-A (PR #496,
  `growth-project-backend`, merged).
- **`POST /api/scout/ingest`** — already assumed by `_interface.js`; confirm
  it routes by bearer-token identity (no body-level account field required).
  **Backend PR (formerly PR-B) not yet built.**
- **`POST /api/scout/progress`** — per-commit progress snapshot forwarded to
  the mobile app. Body is the same shape the popup receives via
  `chrome.runtime.sendMessage`. **Not yet built.**
- **`POST /api/scout/ingest/complete`** — terminal completion call. Confirm
  the path and that it is idempotent per import. **Not yet built.**

---

*Sources for the platform landscape and host patterns cited in `ROADMAP.md`.*
