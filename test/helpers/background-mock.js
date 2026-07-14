// Chrome mock for exercising background.js as a whole module. background.js
// registers runtime/message/lifecycle listeners at import and pulls in
// shared/capture.js (registerCaptureLifecycle), so the mock provides every
// surface those touch. Storage is backed by plain Maps so a test can inspect
// exactly what was persisted and where.

function eventHub() {
    const set = new Set();
    return {
        api: { addListener: (fn) => set.add(fn), removeListener: (fn) => set.delete(fn) },
        emit: (...args) => { for (const fn of [...set]) fn(...args); },
        first: () => [...set][0],
    };
}

// A minimal chrome.storage.StorageArea over a Map. get accepts a single string
// key (the only shape background.js uses) and returns { [key]: value } or {}.
function storageArea(seed) {
    const map = new Map(seed ?? []);
    return {
        map,
        area: {
            get: async (key) => (map.has(key) ? { [key]: map.get(key) } : {}),
            set: async (obj) => { for (const [k, v] of Object.entries(obj)) map.set(k, v); },
            remove: async (key) => { map.delete(key); },
        },
    };
}

// makeBgMock({ session }) — `session` seeds chrome.storage.session so a test can
// simulate a service-worker restart (session survives) vs a browser restart
// (session empty).
export function makeBgMock({ session } = {}) {
    const onMessage = eventHub();
    const sessionStore = storageArea(session);
    const localStore = storageArea();
    const sent = [];
    const notifications = [];
    const syncSet = [];

    const chrome = {
        runtime: {
            id: "test-extension-id",
            onInstalled: eventHub().api,
            onStartup: eventHub().api,
            onSuspend: eventHub().api,
            onMessage: onMessage.api,
            sendMessage: (msg) => { sent.push(msg); return Promise.resolve(undefined); },
        },
        storage: {
            session: sessionStore.area,
            local: localStore.area,
            sync: { set: async (obj) => { syncSet.push(obj); } },
        },
        debugger: {
            onEvent: eventHub().api,
            onDetach: eventHub().api,
            attach: async () => {},
            detach: async () => {},
            sendCommand: async () => ({}),
        },
        tabs: { onRemoved: eventHub().api, get: async (id) => ({ id }) },
        notifications: { create: (opts) => { notifications.push(opts); } },
    };

    // Invoke the registered onMessage listener and resolve to the value the
    // handler passes to sendResponse. Honours the MV3 `return true` async
    // contract: a truthy return keeps the channel open until sendResponse fires.
    // The default sender models a trusted extension page (the pairing popup):
    // same extension id, an extension-origin URL, and no originating tab — the
    // exact shape the token-bearing session_established path requires.
    const extensionPageSender = {
        id: chrome.runtime.id,
        url: `chrome-extension://${chrome.runtime.id}/popup/pair.html`,
    };
    function dispatch(message, sender = extensionPageSender) {
        return new Promise((resolve) => {
            let settled = false;
            const sendResponse = (r) => { settled = true; resolve(r); };
            const listener = onMessage.first();
            const kept = listener(message, sender, sendResponse);
            if (kept !== true && !settled) {
                resolve(undefined);
            }
        });
    }

    return {
        chrome,
        dispatch,
        sent,
        notifications,
        syncSet,
        sessionMap: sessionStore.map,
        localMap: localStore.map,
    };
}

export function installChrome(mock) {
    globalThis.chrome = mock.chrome;
}
