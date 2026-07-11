# TGP Importer (Chrome Extension)

Browser-side importer that transfers a coach's TrueCoach clients (and related
entities) into TGP from inside their own logged-in tab.

## Layout

```
manifest.json
background.js              # MV3 service worker (dispatch, ingest, session boundary)
shared/
  protocol.js              # shared message protocol + config + PAIRING_ENABLED flag
  session.js               # single session/token-lifecycle owner (memory access + storage.session refresh)
  pairing.js               # POST /api/extension/pair/redeem → session_established (the only session producer)
content/
  main.js                  # minimal content script (announces a live platform tab)
extractors/
  _interface.js            # LOCKED extractor contract (M-IMPORTER-EXTENSION v0)
  detect.js                # detectPlatform(url) dispatcher (hostname-suffix match)
  truecoach.js             # public barrel for the TrueCoach extractor
  truecoach/
    extractor.js           # TrueCoachExtractor orchestration class
    parse.js               # pure parsers + entity builders
    net.js                 # runtime networking + date-window walker
    library.js             # org-level library (exercises, programs, ...)
    identity.js            # /organizations bootstrap
    goal.js                # HTML-fragment goal endpoint parser
popup/
  popup.html popup.js      # import status + per-entity progress UI
  pair.html pair.js        # 6-digit pairing-code redeem view (the only sign-in surface)
docs/
  DESIGN.md                # full v0.2 spec (autonomous crawl, WL taxonomy, R136)
  ROADMAP.md               # platform matrix + version cutlines
  first-principles.md      # R136 companion (sourced constraints + assumptions)
  export-recipes/          # per-platform user-assisted export walkthroughs
```

## Design v0.3 — see docs/DESIGN.md

The design has moved from the Day-1 TGP-initiated handshake, through the v0.2
inline-login model, to a **mobile-initiated, extension-executed,
backend-brokered pairing** model. Read **`docs/DESIGN.md`** for the
full spec, **`docs/ROADMAP.md`** for the platform matrix + version cutlines,
and **`docs/first-principles.md`** for the sourced hard-constraints /
assumptions split.

Highlights of the redesign:

- **Auth + crawl model** (operator ruling 2026-07-06, supersedes the v0.2
  inline-login ruling): TGP is a mobile app, so there is **no login form in the
  popup**. The single no-session→session path is a mobile-minted 6-digit
  pairing code redeemed via `POST /api/extension/pair/redeem` (`popup/pair.js` +
  `shared/pairing.js`). The bearer token IS the account binding; the crawl is a
  fully autonomous background-worker API walk (no tab navigation). This replaces
  both the `INTENT_QUERY_PARAM` handshake and the retired v0.2 inline login.
- **Site-agnostic north star** (operator ruling 2026-06-30 17:06 PDT): a
  `detectPlatform(url)` dispatcher + per-platform extractor behind the locked
  `_interface.js`, targeting the top-10 coaching platforms, with a
  user-assisted export fallback and (v1.0) a BYO-extractor SDK.

## Doctrine notes

- R75: zero banned type-assertions in any module — every narrowing uses a
  real type guard (see `isRecord`, `isTcClient`, `isStartIngest`, ...).
- R76: every module ≤ 400 LOC.
- Interface in `extractors/_interface.js` is **locked**; changes require an
  operator ruling because they break every downstream extractor.

## Backend dependencies (TGP-side)

- `POST /api/extension/pair/redeem` — the pairing-code redeem (see
  `docs/DESIGN.md` §4 + §13 + the "Backend dependencies" section). **Not yet
  built** (IMPORTER-D, PR #502), so redemption ships gated behind
  `PAIRING_ENABLED` (default `false`) in `shared/protocol.js`.
- `POST /auth/extension/refresh` — access-token refresh + rotation. Delivered
  by IMPORTER-A (PR #496, merged).
- `POST /auth/extension/logout` — refresh-family revocation. **Not yet built**;
  the extension therefore makes **no logout/revocation call** and claims no
  revocation guarantee. `shared/session.js#clearTokens` clears local token
  state only.
- `POST /api/scout/ingest` (route by bearer identity) + `/api/scout/ingest/complete`.
