// Minimal chrome.debugger mock for capture tests. Records attach/detach calls,
// lets tests script sendCommand responses, and lets tests emit CDP events.

export function makeChromeMock() {
    const listeners = new Set();
    const commandHandlers = new Map();
    const calls = { attach: [], detach: [], sendCommand: [] };

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
        },
    };

    return {
        chrome,
        calls,
        listenerCount: () => listeners.size,
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
    };
}

export function installChrome(mock) {
    globalThis.chrome = mock.chrome;
}
