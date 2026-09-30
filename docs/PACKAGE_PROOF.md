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

`npm run proof:browser` loads the built archive into an isolated local
Chromium (throwaway profile, every host mapped to NOTFOUND, so no source site,
customer account or TGP API is contacted) and checks via the DevTools pipe,
for the Start-grant flow (no static content script), that: Chrome's loader
accepts the archive and the module worker evaluates with no exception; the
worker it binds to IS the packaged extension (worker URL path,
`chrome.runtime.id`, manifest name/version agree with the shipped manifest —
Chrome also runs its own component-extension workers, which must never be
mistaken for ours); the message router and the Start-grant lifecycle
listeners (`permissions.onAdded/onRemoved`, `tabs.onRemoved/onUpdated`) are
registered; Chrome installed exactly the frozen permission set (no
`activeTab`), exactly the TGP backend host as the one required host, and
https-only optional hosts; a fresh worker holds no optional host grant
(startup sweep); the configured backend origin read from the shipped
`shared/protocol.js` is exactly `https://backend-spring-lake-3890.fly.dev`
and equals that required host; the popup with no session routes to the
pairing view; the popup with a (synthetic, never presented) session renders
as status with exactly one Start button and every other button a status
action (owner D9); a real CDP click on Start from a non-https active page
shows the approved no-run copy, starts nothing, prompts for nothing and makes
no network request; the synthetic secret never reaches disk storage or
console output; and every observed network request targeted the extension
origin. Evidence JSON carries the archive sha256, the inventory's source head
and `Browser.getVersion` verbatim (a Playwright `chromium-*` binary is
labelled Playwright Chromium, not Google Chrome).
`npm run proof:browser:control` re-runs with the packaged worker's module
graph broken (a static import of a file the archive does not ship) and passes
only when the failure has the specific signature of a worker Chrome refused
to evaluate (router never registered) while the static manifest check still
passes. Both need a Chromium binary (`TGP_CHROME`, `--chrome`, or a
Playwright `chromium-*` cache); without one they exit 2 with an explicit
gap. Passing is a loader and boundary proof, not evidence that a customer
import completed; the host-permission prompt itself, the popup closing on
it, worker idle termination during a long prompt and `executeScript` into a
live https tab are not observed.
