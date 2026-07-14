// TGP Importer — content script (minimal). Announces a live platform tab and
// answers THIS extension's own worker with the source bearer read on demand from
// page storage (returned once, never stored/logged).

// A bearer is JWT-shaped (three base64url segments); scan the stores, return the first.
function readSourceBearer(stores) {
    const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
    for (const store of stores) {
        for (let i = 0; i < store.length; i += 1) {
            const value = store.getItem(store.key(i));
            if (typeof value === "string" && JWT.test(value)) {
                return value;
            }
        }
    }
    return "";
}

// Answer a token request ONLY from this extension's own worker (sender.id match);
// a web page cannot address us under our id.
function wireCollector(runtime, stores) {
    runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (sender && sender.id === runtime.id && message && message.kind === "collect_source_token") {
            const token = readSourceBearer(stores);
            sendResponse(token.length > 0 ? { ok: true, token } : { ok: false });
        }
        return false;
    });
}

// Live wiring — guarded so the module imports cleanly under test.
if (typeof chrome !== "undefined" && chrome.runtime && typeof location !== "undefined") {
    chrome.runtime.sendMessage({ kind: "platform_tab_live", url: location.href }).catch(() => undefined);
    wireCollector(chrome.runtime, [sessionStorage, localStorage]);
}

export { readSourceBearer, wireCollector };
