// TGP Importer — content script (minimal, by design).
//
// On document_idle for supported hosts (see manifest content_scripts.matches),
// tell the background worker that a platform tab is live so the popup can offer
// an import. That is the ENTIRE job: no DOM injection, no page manipulation,
// no reading page state. The autonomous crawl runs in the background worker,
// not here (docs/DESIGN.md §2, step 5).
//
// R76: well under 40 LOC.
chrome.runtime
    .sendMessage({ kind: "platform_tab_live", url: location.href })
    .catch(() => undefined);
