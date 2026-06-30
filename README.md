# TGP Importer (Chrome Extension)

Browser-side importer that transfers a coach's TrueCoach clients (and related
entities) into TGP from inside their own logged-in tab.

## Layout

```
manifest.json
shared/
  protocol.js              # shared message protocol + config
extractors/
  _interface.js            # LOCKED extractor contract (M-IMPORTER-EXTENSION v0)
  truecoach.js             # public barrel for the TrueCoach extractor
  truecoach/
    parse.js               # pure parsers + entity builders
    net.js                 # runtime networking + date-window walker
    library.js             # org-level library (exercises, programs, ...)
    identity.js            # /organizations bootstrap
    goal.js                # HTML-fragment goal endpoint parser
popup/
  popup.html
  popup.js
```

## Status — initial drop (Day 1, TrueCoach only)

This first commit contains the files the operator handed off. Day-1 scope is
TrueCoach only; the manifest still references three files that are **not yet
in the repo** and must be added before the extension will load in Chrome:

- `background.js` (manifest `background.service_worker`)
- `content/main.js` (manifest `content_scripts[0].js`)
- `extractors/truecoach/extractor.js` (imported by `extractors/truecoach.js`)

Tracking these as the immediate follow-up.

## Doctrine notes

- R75: zero banned type-assertions in any module — every narrowing uses a
  real type guard (see `isRecord`, `isTcClient`, `isStartIngest`, ...).
- R76: every module ≤ 400 LOC.
- Interface in `extractors/_interface.js` is **locked**; changes require an
  operator ruling because they break every downstream extractor.
