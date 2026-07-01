# TGP Importer — Design v0.2

> Status: **design** (pre-release, `manifest.version = 0.2.0-design`).
> Supersedes the Day-1 TrueCoach-only drop. Locked by operator ruling on
> 2026-06-30 (17:02 PDT — auth + crawl model; 17:06 PDT — site-agnostic north
> star). This document is the single source of truth for what v0.1 builds and
> what later versions defer to (see `ROADMAP.md`). First-principles / doctrine
> framing lives in `first-principles.md`.

---

## 1. Goal

Site-agnostic import into TGP. A coach signs in once inside the extension and
pulls their entire client roster, programs, library, and history out of
whatever platform they currently use — without TGP ever holding that
platform's credentials, and without the coach doing manual CSV surgery.

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

## 2. User flow (dream flow — locked by operator 2026-06-30)

This is the canonical flow. Do not deviate without an operator ruling.

1. **Install the extension** from the Chrome Web Store (or signed side-load
   during development).
2. **Open the popup.** If no valid session exists, the popup renders the
   **login form** (`popup/login.html`): email + password, plus a secondary
   link **"Create an Account →"** that opens
   `https://app.tgp.coach/signup?ref=importer-extension` in a **new tab**
   (`chrome.tabs.create`). The `ref` query param lets TGP attribute sign-ups to
   the extension funnel.
3. **Authenticate.** Submitting the form issues
   `POST https://api.tgp.coach/auth/extension/login` with `{ email, password }`.
   The backend returns a **short-lived access token** and a **long-lived
   refresh token**. Both are stored in `chrome.storage.local` (see §4 for the
   access-token in-memory caveat).
4. **Source detection.** With a valid session, the popup queries the active
   tab's URL and runs `detectPlatform(url)` (`extractors/detect.js`). If it
   resolves to a supported platform, the popup shows a single primary action:
   **"Import from TrueCoach"** (or the matched platform's name).
5. **Start.** Clicking the button sends `{ kind: "start_ingest", ... }` to the
   background service worker. The worker starts the matched extractor. The
   extraction is a **fully autonomous API walk** — no tab navigation, no DOM
   scripting, no user babysitting. The extractor reuses the coach's existing
   logged-in session on the source platform (cookies + bearer captured in-tab).
6. **Progress.** The worker broadcasts a `status_snapshot` on every batch
   commit; the popup renders per-entity progress bars. This UI already exists
   in `popup/popup.js` (`renderProgress`) and is unchanged by this design.
7. **Completion.** On finish, the worker fires a `chrome.notifications.create`
   toast and posts a terminal
   `POST https://api.tgp.coach/api/scout/ingest/complete` so the backend can
   flip the import to a settled state.

---

## 3. Account binding — the token IS the binding

The bearer token issued in step 3 **is** the account binding. Every ingest
call the background worker makes carries:

```
Authorization: Bearer <extension_access_token>
```

The backend routes the payload to the correct TGP account **by token
identity** — it derives the coach/org from the token, not from any request
body field or cross-tab handshake. There is nothing to reconcile client-side.

### This replaces the `INTENT_QUERY_PARAM` mechanism

The Day-1 build used a **TGP-initiated** handshake: TGP opened the source site
with a `?tgp_intent=<id>` query param (`INTENT_QUERY_PARAM` in
`shared/protocol.js`), the content script read it, and the extension bound the
resulting import to that intent id. That design only worked when **TGP** kicked
off the flow, and it required a live intent row to exist before the coach could
import anything.

The new flow is **extension-initiated**: the coach starts from the popup, the
token carries identity, and no pre-created intent row is needed. The
`INTENT_QUERY_PARAM` / `STORAGE_KEY_INTENT` constants remain in
`shared/protocol.js` for backwards compatibility during migration, but the
v0.2 flow does not depend on them. They should be removed in a later cleanup
once no TGP-initiated imports remain in flight.

---

## 4. Auth model

- **Email/password inline** (operator ruling 2026-06-30 17:02 PDT). The login
  form lives entirely inside the popup; there is no OAuth redirect dance in
  v0.1. Sign-up is **not** inline — the "Create an Account →" link opens
  `app.tgp.coach` in a new tab, so account creation happens on the first-party
  web app where TGP already owns onboarding, email verification, and terms
  acceptance.
- **Token pair.**
  - `POST /auth/extension/login` → `{ access_token, refresh_token, ... }`.
  - `POST /auth/extension/refresh` → new access token (and optionally a rotated
    refresh token) given a valid refresh token. Used for **token rotation** and
    to recover from a 401 mid-crawl.
- **Storage rules (MV3-aware).**
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
    `auth_required`; the popup then falls back to the login view.

---

## 5. White-label taxonomy (three tiers)

Coaching platforms resell themselves under coach/gym brands in three
structurally different ways. The extension's coverage strategy differs per
tier.

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
of failing:

1. The popup surfaces a **per-platform export walkthrough**, sourced from
   `docs/export-recipes/<platform>.md` (this directory ships empty in v0.2 with
   a single `.gitkeep`; recipes are authored as platforms are onboarded).
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
  deaths. Any state that must survive a wake (the refresh token, the progress
  snapshot schema) lives in `chrome.storage.local`; the access token is
  rehydrated via `/auth/extension/refresh` on wake (§4).
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

- **Inline email/password is acceptable to coaches.** If it isn't, we can swap
  to an OAuth flow **without breaking the extractor contract** — only
  `login.html` / `login.js` and the `/auth/extension/*` endpoints change.
- **The TrueCoach REST API is stable.** Shapes are locked from **live
  captures on 2026-06-30**. Re-verify quarterly per R131 (next trigger:
  2026-09-30).
- **The backend exposes `/auth/extension/*`.** This endpoint pair is **not yet
  built** — it is a **TGP-side dependency** (see §Backend dependencies). Until
  it exists, the login flow cannot complete end-to-end.

---

## 9. Per-entity extractor pipeline

The extractor walks entities in a fixed order; the ordering rationale is stated
in `extractors/truecoach/identity.js`:

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
- No test may reach the live network; the `now` injection and fixture replay
  keep runs hermetic.

---

## 12. What ships in v0.1 vs later

Full matrix in `ROADMAP.md`. Summary:

- **v0.1 (build next):** TrueCoach flagship + Tier-1 WL subdomains, inline
  auth (`login.html` / `login.js`), MV3 service worker, autonomous crawl,
  progress UI, completion notification.
- **v0.2:** Tier-2 custom-domain flow (`optional_host_permissions` +
  fingerprint probe).
- **v0.3+:** additional platforms (one at a time, API-verified) and the
  user-assisted export fallback for platforms we cannot crawl.
- **v1.0:** BYO-extractor SDK.

---

## Backend dependencies (flag for operator — create TGP-side tickets)

- **`POST /auth/extension/login`** — email/password → `{ access_token,
  refresh_token }`. **Not yet built.**
- **`POST /auth/extension/refresh`** — refresh token → new access token (+
  optional rotated refresh). **Not yet built.**
- **`GET /signup?ref=importer-extension`** on `app.tgp.coach` — sign-up landing
  that honours the `ref` attribution param. Confirm it exists / accepts the
  param.
- **`POST /api/scout/ingest`** — already assumed by `_interface.js`; confirm it
  routes by bearer-token identity (no body-level account field required).
- **`POST /api/scout/ingest/complete`** — terminal completion call. Confirm the
  path and that it is idempotent per import.

---

*Sources for the platform landscape and host patterns cited in `ROADMAP.md`.*
