// Test helper: wire the REAL content-script token collector (content/main.js)
// over a fake per-origin web-storage so the start_import e2e drives the actual
// producer end-to-end, not a stub. This is what makes the CTA-token test a
// real-behavior test: the bearer that reaches the background is the one the
// shipping content script reads from the coach's own page storage.
import { wireCollector } from "../../content/main.js";

// A minimal Web Storage (sessionStorage/localStorage) surface over a Map, giving
// exactly the members content/main.js reads: length, key(i), getItem(k).
export function fakePageStore(entries = []) {
    const map = new Map(entries);
    const keys = () => [...map.keys()];
    return {
        get length() { return map.size; },
        key: (i) => (i < map.size ? keys()[i] : null),
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, v),
    };
}

// Return a chrome.tabs.sendMessage-compatible responder backed by the REAL
// content-script listener. The extension worker addresses its own content
// script, so the sender id equals the extension id (the trust the content
// script requires). `senderId` overrides that to model an untrusted caller.
export function realSourceTab(extensionId, stores, senderId = extensionId) {
    let listener = null;
    const runtime = { id: extensionId, onMessage: { addListener: (fn) => { listener = fn; } } };
    wireCollector(runtime, stores);
    return (_tabId, message) => new Promise((resolve, reject) => {
        if (listener === null) {
            reject(new Error("no content script"));
            return;
        }
        let answered = false;
        listener(message, { id: senderId }, (r) => { answered = true; resolve(r); });
        if (!answered) {
            // The listener declined (untrusted sender / not a token request) and
            // never answered — model chrome's closed port as a rejected send.
            reject(new Error("port closed"));
        }
    });
}
