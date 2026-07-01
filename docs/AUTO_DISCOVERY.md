# Auto-Discovery — Site-Agnostic Extraction Design

> **Status:** design spec, pre-implementation. This document is the single source of truth for the **PR-C track** (C1 → C4). It sits alongside `DESIGN.md` (v0.2 dispatcher + auth) and `ROADMAP.md` (per-platform matrix + version cutlines). Approved by operator on 2026-06-30 21:36 PDT.

---

## 1. Goal

Cover every JSON-driven coaching platform on the market **without writing per-platform extractor code**. The coach signs in to their platform normally, browses like they always do, and the extension reconstructs the entity graph automatically — clients, programs, workouts, history — and imports it into TGP through the same locked envelope shape (`{intent_id, entity_type, entities:[{source_id, payload}]}`) that the hand-crafted TrueCoach extractor uses.

**Concrete milestone:** one build of the extension covers TrueCoach, Everfit, Trainerize, My PT Hub, PT Distinction, CoachRx, TrainHeroic, FitSW, TeamBuildr, and Kabata — with zero platform-specific code added between v0.7 and v0.9. Hand-crafted extractors remain only for platforms where the auto path produces a low-confidence blueprint after the "Learn" phase.

**North star:** the extension is the last coaching-platform migration tool the coach ever needs. New platforms enter the market → the extension handles them without a release.

---

## 2. Three-layer architecture

### Layer 1 — Passive network capture (site-agnostic)

The extension attaches Chrome's DevTools Protocol to the active tab and records every JSON response the tab receives during the coach's normal browsing. No DOM scraping, no hand-coded URL templates, no per-platform code.

**Chrome APIs:**
- **`chrome.debugger.attach(target, "1.3")`** — opens a CDP session on the target tab. Full DevTools-Protocol access. Reference: [Chrome Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger).
- **`Network.enable`** + **`Network.responseReceived`** + **`Network.getResponseBody`** — receive every response the tab loads, plus the body. Reference: [CDP Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/).
- **Fallback: `chrome.webRequest`** — no permission prompt, but no response body access on cross-origin requests. Used only when the coach declines the debugger prompt.

**Ring buffer:** all captured responses live in a bounded in-memory ring buffer (default 5 MB, LRU by capture time). Binary responses are dropped at header parse (`Content-Type` filter). No IndexedDB persistence — capture is per-session, discarded on extension unload.

**Privacy:** capture is scoped to the coach-opened tab, activated only when the coach clicks "Learn my platform" in the popup, and torn down as soon as the Learn phase ends. Never on by default. Never touches tabs other than the target.

### Layer 2 — Blueprint inference (site-agnostic)

Once the ring buffer has enough captures (see §5 confidence heuristic), the extension runs pure inference over the captured JSON to produce a **platform blueprint**. Three passes:

**Pass A — URL template clustering.** Group captured requests by path pattern. Standard URL-template inference:
- `/api/clients/abc123` and `/api/clients/xyz789` → `/api/clients/:id`
- `/api/programs/12/workouts` and `/api/programs/47/workouts` → `/api/programs/:id/workouts`
- IDs identified by: UUID regex (`^[a-f0-9-]{8,}$`), integer regex (`^\d+$`), short-ID regex (`^[A-Z0-9]{6,16}$`). Only path segments matching a known ID pattern collapse; static segments stay.

**Pass B — Shape clustering.** Group responses by their JSON structural signature (top-level keys + value types + array-vs-object). Two responses with the same signature are the same entity type. Signature computed as a canonical hash of `{sortedKeys, typeMap}` at depth 2 (deeper nesting doesn't help disambiguation and increases false-negatives). Uses [genson-js](https://github.com/aspecto-io/genson-js)-style shape induction, or an equivalent in-house pure function. Every shape cluster becomes a candidate entity type; the extension names it from the URL template's last non-`:id` segment (`/api/clients/:id` → `Client`).

**Pass C — Foreign-key + endpoint-role inference.** For every string field on every entity whose value matches an ID regex, check whether other entities' `id` fields hold values from the same set. That's the join graph: `Client.trainer_id` → `Trainer.id`. Endpoint role is inferred from URL + response:
- URL template with `:id` + response is a single object of shape S → **detail endpoint for S**
- URL template without `:id` + response is `{items: [S]}` or `[S]` → **list endpoint for S**
- Any of the above with `?from=&to=` or `?since=&until=` or `?after=` in query → **windowed list**
- Response containing pagination markers (`next`, `next_cursor`, `has_more`, `next_page`) → **paginated list**

The output is a `PlatformBlueprint`:

```js
{
  platform: "auto:everfit.io",
  api_base: "https://app.everfit.io",
  auth: { style: "bearer", header: "Authorization", captured_from: "GET /api/v2/session" },
  entities: {
    Client: {
      list: { method: "GET", template: "/api/v2/clients" },
      detail: { method: "GET", template: "/api/v2/clients/:id" },
      id_field: "id"
    },
    Program: {
      detail: { method: "GET", template: "/api/v2/programs/:id/details" },
      id_field: "id"
    },
    Workout: {
      windowed: { method: "GET", template: "/api/v2/clients/:id/workouts", window_params: {from: "from", to: "to"} },
      id_field: "id"
    }
  },
  edges: [
    { from: "Client.trainer_id", to: "Trainer.id" },
    { from: "Workout.client_id",  to: "Client.id"  },
    { from: "Program.client_id",  to: "Client.id"  }
  ],
  confidence: 0.87
}
```

Full purity: `induceBlueprint(captureBuffer: Response[]) → PlatformBlueprint` is a pure function. Fully testable against replayed CDP traces without a browser. This is the ~500-LOC brain of the operation and the primary test surface for PR-C2.

### Layer 3 — Autonomous replay (site-agnostic)

Given a blueprint + the coach's captured cookies/bearer, the extension crawls the entity graph:

```
1. entities.Client.list → GET /api/v2/clients → [c1, c2, c3, ...]
2. For each ci:
     entities.Client.detail → GET /api/v2/clients/ci → full client payload
     entities.Program.detail (via edge Program.client_id → Client.id) →
       GET /api/v2/programs/ci/details
     entities.Workout.windowed (via edge Workout.client_id → Client.id) →
       GET /api/v2/clients/ci/workouts?from=X&to=Y (walked backward like TrueCoach)
3. Emit envelope batches to /api/scout/ingest as each entity type completes
```

The replay uses the exact same request pacing as observed during the Learn phase (measured intervals between calls the coach's tab actually made). Never faster. This is critical for rate-limit compliance — most platforms rate-limit "unusual" burst patterns, not baseline browser activity.

Auth is captured passively: whatever `Authorization`, `Cookie`, or custom-header pattern the coach's tab already uses gets recorded during Learn and replayed by the worker. The coach never types a source-platform credential into TGP — they just sign in on the platform's own site as normal.

Emits the same locked envelope shape as the TrueCoach extractor:

```
{ intent_id: <uuid>, entity_type: "client" | "workout" | ..., entities: [{ source_id, payload, sourcePlatform: "auto:<host>", capturedAt }] }
```

`sourcePlatform` gets `auto:` prefix so the backend can tag auto-discovered vs hand-crafted extraction in the audit log.

---

## 3. User flow (Learn → Confirm → Import)

1. Coach installs extension, opens popup on their coaching platform's tab.
2. Popup detects no supported platform (host not in `HOST_SUFFIXES`). Instead of failing, it renders **"Learn this platform"** button.
3. Coach clicks it. Popup shows friendly instruction: *"Browse your platform normally for 60 seconds. Visit your Clients tab, open a client, open their program. We'll watch and figure out how to import."* Debugger-attach permission prompt appears (Chrome's own prompt: *"Extension started debugging this browser"*).
4. Coach clicks through the prompt. Extension attaches CDP, capture buffer starts filling. Popup shows live counter: *"Captured 12 endpoints, 47 responses. Keep browsing..."*
5. Extension runs blueprint inference every 5 seconds against the current buffer. When `confidence ≥ 0.75` AND at least one detail endpoint has been captured for the top-3 largest entity clusters (typically Client + Program + Workout), popup flips to **"Ready — 3 entity types discovered. Import now?"**
6. Coach clicks Import. Popup shows discovered blueprint (entity list + counts) with an "Edit blueprint" secondary link for the paranoid.
7. Coach confirms. Extension detaches debugger, worker starts autonomous replay. Progress UI is identical to hand-crafted extractors (already implemented in `popup.js`).
8. On completion, extension fires terminal `/api/scout/ingest/complete` and shows toast.

**Fallback:** if after 3 minutes of browsing `confidence < 0.6`, popup shows *"We couldn't figure this platform out automatically. Would you like the guided export path?"* → opens `docs/export-recipes/<host>.md`.

---

## 4. Confidence heuristic (§5 of the flow)

A blueprint's confidence is a weighted score:

```
confidence =
    0.30 * (fraction of entity clusters with BOTH list and detail endpoints)
  + 0.20 * (fraction of foreign-key edges that resolve — target has matching IDs)
  + 0.20 * (min of: captured responses per entity type / 3, capped at 1.0)
  + 0.15 * (auth mechanism inferable: 1.0 if consistent header/cookie across all requests, 0.0 otherwise)
  + 0.15 * (URL templates are consistent — no `:id` segments containing IDs that also appear as non-`:id` segments elsewhere)
```

Rationale for each weight:

- **List + detail** (0.30) — most important. Without both, we can't crawl.
- **FK resolution** (0.20) — high-signal that the entity model is coherent.
- **Sample density** (0.20) — need at least a few examples per shape cluster to be confident in the signature. Cap prevents runaway from one giant response type.
- **Auth consistency** (0.15) — if half the requests are bearer and half are session cookies, something's weird (probably straddling auth boundaries). Downweight but don't block.
- **URL template consistency** (0.15) — catches the case where the URL-template pass over-eagerly collapses static segments containing digits (like a version number `/api/v2/`).

The 0.75 threshold was chosen because it's high enough to reject noisy sessions but low enough to accept sessions where the coach only touched 3 of 5 entity types. A lower confidence (0.60–0.75) still enters replay but shows the blueprint for coach confirmation first.

---

## 5. What Layer 1 doesn't capture

Three categories where pure passive capture fails, listed with mitigations:

### 5a. Server-side rendered HTML (SSR)
Response body is HTML, not JSON. The API-driven inference is useless.

**Mitigation:** Layer 4 — **DOM extractor overlay**. Extension `chrome.scripting.executeScript` runs a per-page CSS-selector list against the tab's DOM, still using the passive-capture layer to identify _which_ pages contain client/program lists. Selectors are crowd-sourced (a signed selector pack per platform in `extractors/dom-packs/<platform>.json`) — much cheaper than a full hand-crafted extractor.

Shipped in **PR-C4**.

### 5b. Encrypted / proprietary payloads
Some platforms use custom binary formats or e2e-encrypted client-model shapes. Rare in coaching SaaS but exists for enterprise-team platforms.

**Mitigation:** Layer 5 — **user-assisted export recipes** at `docs/export-recipes/<platform>.md`. A markdown recipe walks the coach through the platform's own export tool (usually CSV/XLSX download in Settings → Export Data), then the extension parses the resulting file. Same envelope shape, coach does the click-through instead of the crawl.

Recipes tracked in the ROADMAP under v0.9.

### 5c. Mobile-only API access
Some platforms gate their API to native-app user-agents. The web app is a thin marketing site; real data lives behind the mobile SDK.

**Mitigation:** documented refusal + recipe. Not economical to reverse-engineer a mobile app just to import a coach's data. Falls back to 5b.

---

## 6. PR-C track breakdown

Each PR is a mergeable ~300-400 LOC unit against `tgp-importer-extension`. Each dual-lensed (Opus 4.8 + gpt_5_5) per R72 before merge.

### PR-C1 — Capture layer

**Adds:**
- `shared/capture.js` — debugger attach/detach lifecycle, `Network.enable`, `Network.responseReceived` handler, `Network.getResponseBody` fetch, JSON filter, ring buffer.
- `shared/capture-buffer.js` — bounded ring buffer (5 MB cap, LRU by capture time, binary drop).
- `manifest.json` — adds `debugger` + `scripting` permissions.
- Tests: `test/capture.spec.js`, `test/capture-buffer.spec.js`, with fixtures at `test/fixtures/cdp-traces/` (replayed CDP event streams from real captures).

**Depends on:** PR-A merged (extension worker needs coach identity for eventual `/api/scout/ingest` calls).

**Doesn't need:** PR-B (no ingest yet; capture-only).

**Doctrine:** R109 no half-ass — the debugger permission prompt gets a proper explainer UI, not just "OK". Every capture failure logs + surfaces + degrades to `webRequest` fallback.

### PR-C2 — Blueprint inference

**Adds:**
- `shared/blueprint/url-templates.js` — Pass A (URL template clustering).
- `shared/blueprint/shapes.js` — Pass B (shape clustering + signature hashing).
- `shared/blueprint/edges.js` — Pass C (foreign-key + endpoint-role inference).
- `shared/blueprint/confidence.js` — the confidence heuristic from §4.
- `shared/blueprint/index.js` — public `induceBlueprint(captureBuffer) → PlatformBlueprint`.
- Tests: extensive, with real captured fixtures from TrueCoach + one Everfit dev capture.

**Depends on:** PR-C1 (capture buffer shape defined there).

**Doctrine:** pure functions only. No side effects, no network I/O, no `chrome.*` calls. Fully browser-independent test surface.

### PR-C3 — Autonomous replay + Learn UI

**Adds:**
- `extractors/auto/replay.js` — takes `PlatformBlueprint` + captured auth + emits envelope batches.
- `extractors/auto/pacer.js` — measures observed request cadence during Learn, throttles replay to match.
- `popup/learn.html` + `popup/learn.js` — the Learn/Confirm UI from §3.
- Integration with existing `background.js` worker → new `kind: "start_auto_ingest"` message.
- Tests: end-to-end against a captured Everfit dev session with a mock backend endpoint (or dump-to-file if PR-B still in flight).

**Depends on:** PR-C2.

**Doesn't need:** PR-B (mocks the ingest endpoint until PR-B lands; C4 wires it up for real).

### PR-C4 — Real backend wiring + DOM fallback

**Adds:**
- Replaces the mock ingest handler with real `POST /api/scout/ingest` + `/api/scout/ingest/complete` calls (needs PR-B merged).
- `extractors/dom/executor.js` — Layer 4 DOM extractor for SSR platforms.
- `extractors/dom-packs/*.json` — first 2 crowd-sourced selector packs.
- End-to-end tests hitting a real (test-env) backend.

**Depends on:** PR-C3 + PR-B both merged.

---

## 7. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Debugger permission scares off coaches | Medium | Medium | Explainer UI + one-sentence rationale + `webRequest` fallback for the timid |
| Blueprint over-eagerly collapses static path segments | Medium | Low | Templates require ≥ 3 distinct ID values before collapsing; static-vs-ID heuristic weight in confidence score |
| Rate limits during replay | Low (pacer matches observed cadence) | High if triggered | Observed-cadence throttling, +20% safety multiplier, on-429 exponential backoff, hard-stop after 3 consecutive 429s |
| Auth token expiry mid-crawl | Medium | Medium | Blueprint captures the coach's session refresh mechanism if visible; if not, extension re-attaches and re-learns auth on 401 |
| Cross-tab capture leakage | Low (debugger is per-target-tab) | High privacy blast if leaked | Target ID pinned to the tab the coach clicked "Learn" on; capture buffer keyed to `tabId`; buffer discarded on tab close |
| Blueprint mis-inference produces wrong entity model | Medium | High (corrupt import) | Confidence threshold + coach-visible blueprint confirmation before replay + full audit log of every replay request server-side |

---

## 8. Success metrics

- **Coverage:** number of coaching platforms importable via the auto path with `confidence ≥ 0.75` after a 60-second Learn session. Target: 8 of the top-10 platforms by v0.7.
- **Coach time to first import:** median wall-clock from install to first successful import completion. Target: under 4 minutes (60s Learn + 30s confirm + 90–180s replay for a 20-client roster).
- **Blueprint accuracy:** percentage of auto-discovered blueprints that need zero coach edits before replay. Target: ≥ 90% on the top-10 platforms.
- **Recall:** fraction of client/program/workout entities that reach the backend, measured against the coach's own reported count. Target: ≥ 98%.

Metrics are captured in the audit log server-side (already present in PR-B design) and reported in a per-coach summary at import completion.

---

## 9. What this design deliberately does NOT do

- **No ML.** All inference is deterministic pure functions. Coach can eyeball the blueprint and it's the same every time.
- **No selectors as a first-class layer.** DOM extraction is a fallback for SSR platforms, not the default path. If the platform has JSON APIs, we use them.
- **No credential handling on TGP's side.** The coach signs in on their platform's own site; the extension replays captured auth. TGP never sees the source-platform password.
- **No cross-platform normalization at the extension.** Entities are emitted as-is with `sourcePlatform` provenance; backend does the normalization (already in PR-B design).
- **No platform detection database.** No hard-coded knowledge of Everfit or Trainerize's API shapes. Discovery happens at Learn time. That's the whole point.

---

## 10. Timeline

Post PR-A merge:

| Week 1 | PR-C1 build + audit + merge | PR-B build + audit + merge (parallel track) |
|---|---|---|
| Week 2 | PR-C2 build + audit + merge | — |
| Week 3 | PR-C3 build + audit + merge | — |
| Week 4 | PR-C4 build + audit + merge | Chrome-loadable v0.1 handed to operator |

Each PR is ~300-400 LOC prod + ~600-800 LOC test (R74 discipline). Roughly 5-7 days each end-to-end including dual-lens rounds. Aggressive but tractable at the pace Wave 1.5 just proved.
