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
    const calls = { attach: [], detach: [], sendCommand: [] };

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
        },
        runtime: {
            onSuspend: onSuspend.api,
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
        // MV3 lifecycle emitters.
        emitDetach: (source) => onDetach.emit(source),
        emitTabRemoved: (tabId, info) => onRemoved.emit(tabId, info ?? { isWindowClosing: false }),
        emitSuspend: () => onSuspend.emit(),
    };
}

export function installChrome(mock) {
    globalThis.chrome = mock.chrome;
}
