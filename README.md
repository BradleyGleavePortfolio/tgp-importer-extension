# TGP Importer (Chrome Extension)

Browser-side importer that transfers a coach's TrueCoach clients (and related
entities) into TGP from inside their own logged-in tab.

## Layout

```
manifest.json
background.js              # MV3 service worker (token lifecycle, dispatch, ingest)
shared/
  protocol.js              # shared message protocol + config
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
  login.html login.js      # email/password sign-in + "Create an Account →"
docs/
  DESIGN.md                # full v0.2 spec (autonomous crawl, WL taxonomy, R136)
  ROADMAP.md               # platform matrix + version cutlines
  first-principles.md      # R136 companion (sourced constraints + assumptions)
  export-recipes/          # per-platform user-assisted export walkthroughs
```

## Design v0.2 — see docs/DESIGN.md

The design has moved from the Day-1 TGP-initiated handshake to an
**extension-initiated, site-agnostic** model. Read **`docs/DESIGN.md`** for the
full spec, **`docs/ROADMAP.md`** for the platform matrix + version cutlines,
and **`docs/first-principles.md`** for the sourced hard-constraints /
assumptions split.

Highlights of the redesign:

- **Auth + crawl model** (operator ruling 2026-06-30 17:02 PDT): inline
  email/password sign-in in the popup; the bearer token IS the account binding;
  the crawl is a fully autonomous background-worker API walk (no tab
  navigation). This replaces the `INTENT_QUERY_PARAM` handshake in
  `shared/protocol.js`.
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

## Backend dependencies (TGP-side, not built yet)

- `POST /auth/extension/login` and `POST /auth/extension/refresh` (see
  `docs/DESIGN.md` §4 + the "Backend dependencies" section).
- `app.tgp.coach/signup?ref=importer-extension` sign-up landing.
- `POST /api/scout/ingest` (route by bearer identity) + `/api/scout/ingest/complete`.
