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
| 6 | A run that **threw** was never settled | Defect 1 fixed the body of the complete call, but only on the path where `runReplay` *returns*. A source 401/403 raises `AuthLostError` and propagates, so the run left the orchestration through the catch — which broadcast `ingest_failed` and posted nothing. The coach saw a finished import; the backend intent stayed `running` forever. A source session expiring mid-crawl is the single most routine way a real import ends. |
| 7 | `final_counts` was `{ pages, entities }` | Read as the per-entity tally the field name promises, that is a count of two entity types no coach has: `pages` is not an entity, and `entities` is a run total wearing an entity's name. A coach reconciling a migration could not tell from the settled record whether their notes came across. |

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
- **`shared/replay/engine.js`** — `result.counts`, a per-entity tally summed by
  `entityType` across steps. Built through a `Map`, so an `entityType` of
  `__proto__` (adapter data, auto-inferred from untrusted capture in PR-C2)
  becomes a real own property instead of silently discarding its count.
- **`background.js`** — maps engine status onto the backend's terminal enum,
  sends only DTO-declared fields, settles every non-cancelled outcome —
  *including the ones that threw* — attaches `retryAfterMs` from a 429 response,
  mints a non-secret device id, wires the progress reporter, and reports
  `final_counts` as the per-entity tally.

### Settling a run that threw

`settleFailed()` posts `terminal_status: failed` on the catch path, **before**
the `ingest_failed` broadcast. Ordering is the substance of the fix, not a
detail: a broadcast that lands first opens a window in which the coach has been
told the import ended while the backend still has it running, and an MV3 worker
suspended in that window never closes it.

Three constraints hold it honest:

- **`final_counts` is omitted, not guessed.** No tally exists on this path and
  the DTO makes the field optional, so nothing is asserted about what landed.
- **At most one settlement per intent.** `settlementSent` is set before the
  first complete, so a *rejected* complete on an otherwise good run is not
  re-settled as `failed` — that would record a failure for a run that did not
  fail. The run still surfaces as `ingest_failed` to the coach, because an
  unacknowledged settlement is not a confirmed import.
- **It cannot mask the real fault.** The settlement is best-effort; the coach
  still sees the source failure, and a source 401/403 still routes to a source
  re-login rather than TGP pairing.

A TGP-side auth loss is the one started intent still left unsettled, and
deliberately: the tokens a complete would carry are exactly the ones just
cleared, so the POST could only 401. Closing that intent needs a re-pair (or a
backend-side expiry), not another unauthenticated call.

The same catch-path gap existed on the legacy `start_ingest` entrypoint and is
fixed identically.

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
  needed to feed it are now on the wire twice — live in `progress[]` and settled
  in `final_counts`, where a drifted step shows as an explicit `0` rather than an
  absent key — so the input side of that rung is in place. What is still missing
  is only the baseline to compare them against.
- **Settling a run lost to TGP auth.** See above: no credential survives to
  authenticate the complete. Needs a backend-side expiry or a settle-on-re-pair,
  neither of which is an extension-only change.
- **Retry budget across pages.** Backoff is per-page. A source that 429s every
  page still walks every page. A run-level rate-limit circuit breaker is a
  separate, larger change.

## Standing constraints preserved

SSRF confinement (`allowedOrigins` still a required capability threaded into
`normalizeBlueprint` before any fetch), token isolation (no credential added to
disk storage; the device id is a random non-secret), consent and default-OFF
capture (untouched), TrueCoach product gates (untouched), no real-account
claims. No flag was flipped; `PAIRING_ENABLED` is unchanged.
