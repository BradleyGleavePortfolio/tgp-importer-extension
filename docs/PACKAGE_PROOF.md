# Package and browser-load proof

`npm run package` builds `dist/tgp-importer-extension-<version_name>.zip` from
the manifest closure only (service worker module graph, classic content
scripts, page module graphs, icons, locales). It fails closed on any reference
to a missing file, a path outside the extension root, a development-only tree
(`test/`, `scripts/`, `docs/`, `node_modules/`, fixtures), a classic content
script that contains ES module syntax or does not compile, or a page script
that is not `type="module"`. The archive is deterministic (STORE, fixed
timestamps, sorted paths) so the same tree always yields the same sha256,
recorded with per-file hashes in the sibling `.inventory.json`.

`test/package-integrity.spec.js` pins those invariants, including the frozen
permission and host sets and the historical main-branch defect (an `export`
in `content/main.js`) as a negative case.

`npm run proof:browser` loads the built archive into an isolated local Chrome
(throwaway profile, all DNS mapped to NOTFOUND except a synthetic
`app.truecoach.co` served by a local TLS server pinned by SPKI for that process)
and checks via the DevTools pipe that the worker it binds to IS the packaged
extension (worker URL path, `chrome.runtime.id`, manifest name/version agree
with the shipped manifest — Chrome also runs its own component-extension
workers, which must never be mistaken for ours), that the popup loads, learns
there is no paired session and redirects to the pairing view (the truthful
fresh-profile state), that the classic content script runs on the synthetic
origin, that `collect_source_token` returns the synthetic token or `{ ok: false }`,
that the token never appears in storage or console output, and that every
observed network request targeted the synthetic host or the extension origin.
Evidence JSON carries the archive sha256 and the inventory's source head.
`npm run proof:browser:control` re-runs with the historical defect re-applied
and passes only when the failure has the specific no-receiver signature
(`chrome.tabs.sendMessage` finds no listener in the tab) while every unrelated
check still passes. Both need a Chrome binary (`TGP_CHROME`
or a Playwright `chromium-*` cache); without one they exit 2 with an explicit
gap. Passing is a loader and boundary proof, not evidence that a customer
import completed.
