# TGP Importer — Design v0.3

> Status: **design** (pre-release). Target `manifest.version = 0.3.0-design`;
> the repo `manifest.json` currently declares `0.2.0-design` and is bumped to
> `0.3.0-design` by the v0.1 implementation PR (this design PR is docs-only).
> Supersedes v0.2 (2026-06-30 inline email/password model). Locked by operator
> ruling on 2026-07-06 (mobile-app-initiated pairing flow — TGP is a mobile app,
> not a web app, so the desktop popup can no longer carry the login surface).
> This document is the single source of truth for what v0.1 builds and what
> later versions defer to (see `ROADMAP.md`). First-principles / doctrine
> framing lives in `first-principles.md`.

> **Two version axes — do not conflate.** "Design v0.3" is the revision number
> of *this specification document* (v0.2 → v0.3 was the inline-login → pairing
> rewrite). It is independent of the **product release milestones** v0.1…v1.0 in
> `ROADMAP.md`, which describe *shipped extension capability* (v0.1 = TrueCoach
> flagship + pairing auth, … v1.0 = BYO-extractor SDK). One design revision can
> describe several release milestones. Both are also distinct from
> `manifest.version` (the packaged artifact version, e.g. `0.3.0-design`). When
> this doc says "v0.1 builds X" it means the *release milestone*; "Design v0.3"
> means *this document's revision*.

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
   system. The mobile app polls
   `GET /api/extension/pair/status?pairing_id=...` — keyed by the opaque
   `pairing_id` returned by `pair/init`, **never** the 6-digit code (see
   §13.5) — waiting for the pairing signal.
4. **"Choose your previous site"** page on the mobile app. The coach selects
   the source platform (TrueCoach, Trainerize, My PT Hub, etc. — driven by the
   `ROADMAP.md` matrix). This selection is stored server-side against the
   pairing code so the extension knows which platform to target the moment it
   redeems.
5. **Pairing code display.** The mobile app calls
   `POST /api/extension/pair/init` with `{ chosen_platform }`. The backend
   returns `{ pairing_id, pairing_code, expires_at }` — an opaque `pairing_id`
   for status polling (§13.5) plus a **6-digit numeric code** with a
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
    progress rows (unchanged from earlier versions — `popup/popup.js`
    `renderProgress`). It additionally posts the same snapshot to
    `POST /api/scout/progress` so the mobile app's progress screen can update
    via its existing poll/socket path. Cross-device progress mirroring is a
    hard requirement of the mobile-first UX.
11. **Completion.** On finish, the worker fires a
    `chrome.notifications.create` toast on desktop and posts a terminal
    `POST https://api.tgp.coach/api/scout/ingest/complete` so the backend can
    flip the import to a settled state and push a completion notification to
    the mobile app.

> **"Transfer data" CTA status (ships v0.3.5).** The "Transfer data? ETA ~2
> min" CTA and its `start_ingest` message (step 9) are **future behavior**: the
> current `popup/popup.js` renders status/empty/error state and sends only
> `{ kind: "request_status" }`. When the CTA lands in the v0.3.5 build, tapping
> it sends `{ kind: "start_ingest", ... }` to the background worker, which
> resolves the stored `session.chosen_platform`, starts the matched extractor's
> autonomous API walk, and drives the progress rows (§10). The step-9 text
> above describes the intended v0.3.5 behavior, not the currently shipped popup.

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
  - `POST /auth/extension/logout` → **revokes** the coach's extension refresh
    token and its rotation family. Called on explicit disconnect/logout and on
    uninstall cleanup; after it succeeds the extension clears local token state
    and returns to the pairing view (threat model §13.4).
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
- **Progress endpoint auth & ordering.** `POST /api/scout/progress` is
  authenticated with the coach's extension **Bearer**; the backend derives the
  coach/import binding from the **token identity**, never a body field. Each
  snapshot carries a **monotonic `seq`** counter per import, and the backend
  **rejects out-of-order deliveries with `409 Conflict`** so a stale or
  replayed snapshot can never regress the progress shown on either device.
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

### Future files (not yet in the repo)

The following paths are referenced normatively above but are **added by the
v0.1 implementation PR**, not this docs-only design PR (paths follow the repo's
existing `popup/` layout):

- `popup/pair.html` — first-run pairing view: single 6-digit input with
  auto-focus/paste plus the extension nonce last-4 (§13.3).
- `popup/pair.js` — redeem call + pairing-view state machine, unit-tested per
  §11.

The legacy `popup/login.html` and `popup/login.js` are **superseded** and are
deleted by the v0.1 build; the current repo still carries them until then.

---

## 13. Pairing & token security model

The pairing code is a short-lived bearer secret bridging two devices, so the
backend endpoints that mint, poll, and redeem it carry the full security
weight of the flow. The requirements below are **normative** for the TGP-side
pairing endpoints (`growth-project-backend`); the extension side only needs to
honour the client obligations called out per subsection.

### 13.1 Redeem brute-force protection

A 6-digit numeric code has only 10^6 possibilities, small enough to attack
within the TTL if `/api/extension/pair/redeem` is reachable without limits.
The backend MUST enforce, as non-negotiable requirements:

- **Per-IP limit:** ≤ 10 redeem attempts per minute per source IP, with
  exponential backoff on repeated failures from the same IP.
- **Per-code cap:** ≤ 5 total redeem attempts against any single code. On the
  5th failed attempt the code is **permanently burned** — marked terminal so
  no further attempt (correct or not) can ever redeem it, and the mobile app
  must mint a fresh code.
- **Global anomaly limit + alerting:** a global redeem-failure rate ceiling
  that trips alerting, so a distributed guessing campaign across many IPs is
  detected even when each IP stays under its own budget.

Client obligation: none — this is backend-enforced. The extension surfaces the
generic failure states from §13.6 without exposing attempt counters.

### 13.2 Atomic single-use redemption (compare-and-swap)

Single-use redemption MUST be an **atomic compare-and-swap** on the pairing
record, not a read-then-write. The redeem handler executes a single
conditional update that both claims and returns the row:

```sql
UPDATE extension_pairing
   SET used_at = now()
 WHERE code = $1
   AND used_at IS NULL
   AND expires_at > now()
RETURNING coach_id, chosen_platform;
```

- Exactly one caller can win: two concurrent redeems for the same code race on
  the same row; the `used_at IS NULL` predicate lets only one `UPDATE` affect a
  row, and the loser gets zero rows back → `already_used`.
- The row is claimed and read **in the same statement** — there is no window
  between checking and consuming the code.
- Exactly one token pair is issued per code, only on the update that returns a
  row. No row returned ⇒ no token minted.

### 13.3 Anti-phishing extension nonce

A displayed 6-digit code can be phished: a fake page could ask the coach to
type it and redeem it from an attacker's client. To bind redemption to the
real extension instance and give the coach a visible cross-check:

- **Extension generates a random nonce** at popup open (CSPRNG, ≥ 128 bits),
  held in memory / `chrome.storage.session` only. It displays the **last 4**
  characters of the nonce to the coach in the pairing view.
- The extension passes the full nonce in `POST /api/extension/pair/redeem`
  alongside the code.
- The backend records the nonce on redeem and **echoes the last 4 back to the
  mobile app** via `GET /api/extension/pair/status`.
- The **mobile UI shows both codes side-by-side**: the pairing code the coach
  typed and the extension's last-4 confirmation. The coach confirms they match
  before the mobile app treats the pair as trusted. A mismatch means the code
  was redeemed somewhere other than the coach's own extension → the coach
  cancels and re-mints.

Client obligation: the extension MUST generate, display last-4, and send the
nonce on every redeem. The mobile UX MUST render the side-by-side confirmation.

### 13.4 Token threat model

The refresh token is long-lived and persisted, so its handling is spelled out
explicitly:

- **Revocation trigger.** Tokens are revoked on coach logout
  (`POST /auth/extension/logout`, §13.7 / §4) and on admin-forced revocation
  (operator or security response). Revocation invalidates the refresh token
  server-side immediately; the next refresh fails and the extension clears
  local state and returns to the pairing view.
- **Rotation cadence.** The refresh window matches the Supabase default; every
  `POST /auth/extension/refresh` MAY return a rotated refresh token, and the
  extension replaces the stored one atomically. Access tokens are short-lived
  and minted on demand.
- **Key material storage.** The access token and the pairing nonce (§13.3) live
  in memory / `chrome.storage.session` **only**, never `chrome.storage.local`.
  The **sole** persisted secret is the rotating refresh token in
  `chrome.storage.local` (required for MV3 wake, §4); it is narrowly scoped to
  the extension audience and single-use per rotation.
- **Stolen-refresh mitigation.** Refresh tokens are **single-use with reuse
  detection**: presenting an already-rotated refresh token is treated as a
  compromise signal → the backend **revokes the entire token family** for that
  coach, forcing a fresh pair from the mobile app.
- **Message-surface hardening.** Tokens are never sent to content scripts or
  page contexts. The background worker validates `sender` on every runtime
  message and rejects any token-bearing message that does not originate from
  the extension's own trusted surfaces. On uninstall/logout all token state is
  cleared.

### 13.5 Opaque `pairing_id` for status polling

The mobile app MUST poll pairing status by an opaque `pairing_id`, **not** by
the 6-digit code. Polling by the code puts the live secret in query strings
(captured by logs, analytics, history, and intermediary tooling) and lets
anyone holding the code learn whether it is `pending | paired | expired`.

- `POST /api/extension/pair/init` returns a random, unguessable `pairing_id`
  alongside the code.
- `GET /api/extension/pair/status?pairing_id=…` is the only status surface;
  the endpoint is scoped to the authenticated mobile session that minted it.
- The 6-digit code never appears in a status URL.

### 13.6 Constant-time compare and generic failures

The backend MUST look up and compare the 6-digit code in **constant time**, so
that response latency does not leak whether a code is valid, expired, or
already used. Concretely:

- Constant-time comparison of the submitted code against the stored value; no
  early-return on first mismatched digit.
- **Uniform client-facing failures.** The extension receives a single generic
  failure signal (with the coarse `expired | already_used | invalid` taxonomy
  for UX routing per §11) and uniform timing/response size. Fine-grained
  reasons are written **only** to authenticated server-side audit logs, never
  exposed as a distinguishable external oracle.

---

## 14. Recovery & edge-case UX

The cross-device flow spans a mobile app, a desktop browser, and a
third-party source platform, so the following non-happy-path states are
**normative** UX, not future polish.

### 14.1 Pairing-code TTL recovery

The pairing code has a nominal 2-minute TTL, but installing/opening the
extension can take longer. If the coach lands on the pairing view past
`expires_at`:

- The **mobile app** shows an **expired-code screen** with a visible countdown
  while the code is live and, on expiry, a single **"Generate new code"** tap
  target. Tapping it re-calls `POST /api/extension/pair/init` and **re-mints**
  a fresh `{ pairing_id, pairing_code, expires_at }`, resetting the status
  poll. Any prior code for that coach/platform is invalidated on re-mint.
- The **extension** pairing view, on an `expired` redeem result, returns to the
  6-digit input with a "code expired — generate a new one on your phone"
  message rather than a dead-end error.

### 14.2 Mobile step-up / re-auth mid-import

If the coach's **TGP mobile session** hits step-up auth (2FA challenge,
re-authentication, or session expiry) while an import is running, the
extension's token operations against TGP begin failing even though the crawl
itself is healthy. In that case:

- The extension detects the TGP-side auth failure (a refresh/ingest call that
  cannot recover via `/auth/extension/refresh`) and shows a dedicated
  **"Reconnect on your phone"** state, pausing ingest rather than erroring out.
- The coach clears the step-up challenge in the TGP mobile app; the extension
  resumes on the next successful token refresh without losing crawl progress.

### 14.3 Mobile ↔ extension clock-drift handling

The desktop and the phone can have materially different local clocks, so TTL
and expiry decisions MUST NOT be made against the local device clock:

- The extension **trusts the server `expires_at`** returned via
  `GET /api/extension/pair/status` (and the redeem/init responses) as the sole
  authority on whether a code is still live. It never compares the code's
  freshness against `Date.now()` on the local machine.
- Expiry is ultimately enforced **server-side** at redeem time (§13.2's
  `expires_at > now()` predicate); the client-side countdown is presentation
  only and is seeded from the server timestamps.

---

## Backend dependencies (flag for operator — create TGP-side tickets)

- **`POST /api/extension/pair/init`** — mobile app calls with
  `{ chosen_platform }`; returns `{ pairing_id, pairing_code, expires_at }`.
  The `pairing_id` is an opaque, unguessable handle used for status polling
  (§13.5). Codes are 6-digit numeric, short-TTL (nominal 2 minutes),
  single-use, and bound to the coach's TGP account + chosen platform at mint
  time. **Not yet built.**
- **`GET /api/extension/pair/status?pairing_id=…`** — mobile app polls by the
  opaque `pairing_id` (never the 6-digit code); returns
  `pending | paired | expired` plus the extension nonce last-4 (§13.3) once
  redeemed. **Not yet built.**
- **`POST /api/extension/pair/redeem`** — extension calls with `{ code }`;
  returns `{ access_token, refresh_token, chosen_platform }` on success, or
  a structured error (`expired`, `already_used`, `invalid`) on failure.
  **Not yet built.**
- **`POST /auth/extension/refresh`** — refresh token → new access token (+
  optional rotated refresh). Delivered by IMPORTER-A (PR #496,
  `growth-project-backend`, merged).
- **`POST /auth/extension/logout`** — revokes the coach's extension refresh
  token and its rotation family. Referenced by the token threat model (§13.4)
  and the extension disconnect/uninstall path but not previously spec'd.
  **Not yet built.**
- **`POST /api/scout/ingest`** — already assumed by `_interface.js`; confirm
  it routes by bearer-token identity (no body-level account field required).
  **Backend PR (formerly PR-B) not yet built.**
- **`POST /api/scout/progress`** — per-commit progress snapshot forwarded to
  the mobile app. Authenticated with the coach's extension Bearer (coach/import
  binding derived from the token, not the body); enforces a monotonic
  per-import `seq` and rejects out-of-order snapshots with `409 Conflict`. Body
  is the same shape the popup receives via `chrome.runtime.sendMessage`.
  **Not yet built.**
- **`POST /api/scout/ingest/complete`** — terminal completion call. Confirm
  the path and that it is idempotent per import. **Not yet built.**

---

*Sources for the platform landscape and host patterns cited in `ROADMAP.md`.*
