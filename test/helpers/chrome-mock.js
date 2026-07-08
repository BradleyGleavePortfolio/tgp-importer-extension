// Minimal chrome mock for capture tests. Records attach/detach calls, lets tests
// script sendCommand responses, emit CDP events, and emit the MV3 lifecycle
// events (tab close, debugger detach, SW suspend) the capture module listens on.

function eventHub() {
    const set = new Set();
    return {
        api: {
            addListener: (fn) => set.add(fn),
            removeListener: (fn) => set.delete(fn),
        },
        set,
        emit: (...args) => {
            for (const fn of [...set]) {
                fn(...args);
            }
        },
    };
}

export function makeChromeMock() {
    const listeners = new Set();
    const commandHandlers = new Map();
    const calls = { attach: [], detach: [], sendCommand: [], tabsGet: [] };

    // Per-tab URL for chrome.tabs.get. Unless a test overrides it, every tab
    // reports an allowlisted TrueCoach URL so capture-path tests pass the
    // origin allowlist by default.
    const tabUrls = new Map();
    const DEFAULT_TAB_URL = "https://app.truecoach.co/clients";

    const onDetach = eventHub();
    const onRemoved = eventHub();
    const onSuspend = eventHub();

    const chrome = {
        debugger: {
            attach: async (target, version) => {
                calls.attach.push({ target, version });
            },
            detach: async (target) => {
                calls.detach.push({ target });
            },
            sendCommand: async (target, method, params) => {
                calls.sendCommand.push({ target, method, params });
                const handler = commandHandlers.get(method);
                return handler ? handler(target, params) : {};
            },
            onEvent: {
                addListener: (fn) => listeners.add(fn),
                removeListener: (fn) => listeners.delete(fn),
            },
            onDetach: onDetach.api,
        },
        tabs: {
            onRemoved: onRemoved.api,
            get: async (tabId) => {
                calls.tabsGet.push(tabId);
                if (tabUrls.has(tabId)) {
                    const url = tabUrls.get(tabId);
                    return url === null ? { id: tabId } : { id: tabId, url };
                }
                return { id: tabId, url: DEFAULT_TAB_URL };
            },
        },
        runtime: {
            onSuspend: onSuspend.api,
        },
    };

    return {
        chrome,
        calls,
        listenerCount: () => listeners.size,
        // Script the URL chrome.tabs.get reports for a tab. Pass null for a
        // tab with no url property (e.g. missing "tabs" permission context).
        setTabUrl: (tabId, url) => tabUrls.set(tabId, url),
        // Register a canned response for a CDP method (e.g. Network.getResponseBody).
        onCommand: (method, handler) => commandHandlers.set(method, handler),
        // Fail a CDP method to exercise error paths.
        failCommand: (method) => commandHandlers.set(method, () => {
            throw new Error(`${method} failed`);
        }),
        emit: (source, method, params) => {
            for (const fn of listeners) {
                fn(source, method, params);
            }
        },
        // MV3 lifecycle emitters.
        emitDetach: (source) => onDetach.emit(source),
        emitTabRemoved: (tabId, info) => onRemoved.emit(tabId, info ?? { isWindowClosing: false }),
        emitSuspend: () => onSuspend.emit(),
    };
}

export function installChrome(mock) {
    globalThis.chrome = mock.chrome;
}
