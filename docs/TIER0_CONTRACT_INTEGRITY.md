# Tier 0 — contract integrity and data-loss prevention

Record of the Tier 0 rung: the smallest set of changes that stop the extension
from silently losing a coach's migration or silently lying about one. Everything
here is a correctness fix against contracts that already exist on
`growth-project-backend` `main`. No new capability, no flag flip, no induction,
no product-gate change.

## What was broken

| # | Defect | Consequence |
|---|---|---|
| 1 | `POST /api/scout/ingest/complete` sent `{ intent_id, platform }` | `terminal_status` is **required** by `ScoutCompleteDto`, and `platform` is **not on the DTO**. The backend runs a global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`, so **every** complete was a 400. Every import intent stayed `running` on the backend forever. |
| 2 | Refresh posted to `/auth/extension/refresh` | The backend's global prefix is `api` and its exclude list does **not** contain `auth`, so the real route is `/api/auth/extension/refresh`. Every refresh 404'd: a perfectly good refresh token sat in `chrome.storage.session` and was never redeemable, forcing a re-pair on every cold service-worker wake. |
| 3 | `POST /api/scout/progress` was never called | The endpoint existed and nothing used it. A long crawl was invisible server-side. |
| 4 | A clean walk yielding zero entities reported `complete` | Every request 200, every page parsed, zero records out — reported to the coach as a successful import. The overwhelmingly likely cause is adapter drift, and "import complete, 0 records" is indistinguishable from "you have no clients". This is the failure mode most able to lose a whole migration without anyone noticing. |
| 5 | 429 was classified non-retryable, and retries had no delay | A rate-limited page was dropped outright. A 5xx burned all three attempts inside one event-loop turn. Both lose data. |

## What changed

- **`shared/session.js`** — refresh endpoint gains the `/api` prefix.
- **`shared/net.js`** — `parseRetryAfterMs` (both RFC 9110 forms, clamped at
  `MAX_RETRY_AFTER_MS`) and a tolerant `readHeader`.
- **`shared/replay/engine.js`** — 429 is retryable; `backoffDelayMs` gives a
  jitter-free exponential schedule that a `Retry-After` hint overrides, both
  capped at `MAX_BACKOFF_MS`; the retry loop now sleeps via the injected `sleep`;
  a new terminal status `empty` for the clean-and-zero case.
- **`shared/progress.js`** *(new)* — bounded, monotone `/api/scout/progress`
  adapter. Bounded: one post per `PROGRESS_MIN_INTERVAL_MS`, never two in
  flight, ≤64 entries, every string clamped to the DTO's `MaxLength`. Monotone:
  `count_committed` is a per-entity high-water mark. Advisory: it cannot throw,
  so a progress failure can never fail an import.
- **`background.js`** — maps engine status onto the backend's terminal enum,
  sends only DTO-declared fields, settles every non-cancelled outcome, attaches
  `retryAfterMs` from a 429 response, mints a non-secret device id, wires the
  progress reporter.

### Status vocabularies are not the same

The engine's words and the backend's enum are distinct, and the mapping is
explicit in `background.js`:

| engine `result.status` | `terminal_status` | popup state |
|---|---|---|
| `complete` | `success` | `ingest_succeeded` |
| `partial` | `partial` | `ingest_partial` |
| `empty` | `partial` + `error_summary` | `ingest_empty` |
| `failed` | `failed` | `ingest_failed` |
| `cancelled` | *(not settled)* | `ingest_failed` |

The backend has no `complete` member and no word for `empty`. A clean-but-zero
walk is reported as `partial` with an `error_summary`, because calling it
`success` would assert the coach has no data.

`cancelled` is deliberately not settled: the coach stopped the run themselves,
and the enum has no member that honestly describes it. Settling it as `failed`
would put a failure on their record for an action they chose.

## Item 6 — the replay state machine is NOT wired here

`shared/replay/state.js` is a pure transition table covering
`ready → learning → confirming → importing → terminal`. It is **not** wired in
this rung, because it is not required for the correctness of any defect above:
every fix here is a wire-format or terminal-classification fix inside the
existing single-flight orchestration, and `background.js` already tracks the one
piece of state that matters (`importInFlight`). Introducing a second state
authority alongside it would add a synchronisation surface this rung does not
need, and would touch the LEARNING/CONFIRMING states that only exist for
inference — which is gated behind the C1 server-intent freeze.

### The next exact rung

**PR-11 — replay state machine as the single orchestration authority.**
Preconditions, all of which are outside this rung:

1. **C1 server intent freezes.** The state machine's `ready` state must be
   entered from a server-issued intent, not a locally minted `imp-${Date.now()}`
   id. Wiring it against the local id would have to be redone.
2. **Durable resume/revocation lands.** The machine's value is surviving a
   service-worker death mid-`importing`; without a durable state record it is a
   more ceremonious in-memory boolean.
3. **`importInFlight` is retired in the same change.** Two authorities for "is a
   run in progress" is worse than one, so the swap must be atomic.

Scope when it lands: replace `importInFlight` with `transition()`, persist the
state alongside the snapshot, and route the popup off the machine's state rather
than off `intent.status` strings. LEARNING/CONFIRMING stay unreachable until
blueprint inference (PR-C2) merges.

## Deliberately out of scope

- **Settling a `cancelled` run.** See above — no honest enum member exists.
  Needs a backend contract change, not an extension change.
- **`total_estimated` as a real total.** The crawl discovers pages as it walks,
  so no true total exists mid-run. The committed count is used as the only
  honest lower bound. A real estimate needs a count endpoint per entity type.
- **Distinguishing genuine emptiness from drift.** `empty` says "verify this",
  not "this is drift". Actually deciding requires the drift canary, which is a
  capture/induction concern behind the C1 freeze.
- **Per-entity emptiness.** `empty` is a whole-run test, so a two-step blueprint
  where one step still returns records and another's `itemsPath` no longer
  resolves classifies as `complete`/`success` — a partial drift is invisible.
  One endpoint changing shape is the *more* common drift mode than all of them
  changing at once, so this is a real remaining gap, not a theoretical one. It is
  out of scope here because the honest fix is not a stricter terminal test: a
  step legitimately yielding zero (a coach with no goals set) is indistinguishable
  from a drifted step without a prior expectation to compare against. That
  expectation is the drift canary's job — a per-entity baseline from the last
  successful run — which is the same C1-gated capture concern above. The counts
  needed to feed it already exist in `progress[]` and are now posted, so the
  input side of that rung is already in place.
- **Retry budget across pages.** Backoff is per-page. A source that 429s every
  page still walks every page. A run-level rate-limit circuit breaker is a
  separate, larger change.

## Standing constraints preserved

SSRF confinement (`allowedOrigins` still a required capability threaded into
`normalizeBlueprint` before any fetch), token isolation (no credential added to
disk storage; the device id is a random non-secret), consent and default-OFF
capture (untouched), TrueCoach product gates (untouched), no real-account
claims. No flag was flipped; `PAIRING_ENABLED` is unchanged.
