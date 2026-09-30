// Chrome mock for exercising background.js as a whole module. background.js
// registers runtime/message/lifecycle listeners at import and pulls in
// shared/capture.js (registerCaptureLifecycle), so the mock provides every
// surface those touch. Storage is backed by plain Maps so a test can inspect
// exactly what was persisted and where.

import { readFileSync } from "node:fs";

function eventHub() {
  const set = new Set();
  return {
    api: {
      addListener: (fn) => set.add(fn),
      removeListener: (fn) => set.delete(fn),
    },
    emit: (...args) => {
      for (const fn of [...set]) fn(...args);
    },
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
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) map.set(k, v);
      },
      remove: async (key) => {
        map.delete(key);
      },
    },
  };
}

// makeBgMock({ session }) — `session` seeds chrome.storage.session so a test can
// simulate a service-worker restart (session survives) vs a browser restart
// (session empty).
// makeBgMock({ session, tab, granted }) — `tab` models the coach's live source
// tab that collectSourceToken interrogates: `tab.url` is what chrome.tabs.get
// returns (so the live-origin confinement check runs), and the reply to a
// collect_source_token tabs.sendMessage is `tab.sendMessage(id, msg)` when
// provided, else `{ ok: true, token }` when `tab.token` is set, else
// `{ ok: false }`. tabs.get / sendMessage may be overridden with `tab.get` /
// `tab.sendMessage` to model failures.
//
// Permissions are STATEFUL, as in Chrome: `grants` holds the origin patterns
// Chrome currently holds; `permissions.request` adds one and fires
// permissions.onAdded (the coach accepted the prompt); `permissions.remove`
// drops one. `granted` (default true) is whether the coach accepts prompts.
// `dispatch` of a start_import / start_ingest first performs the popup's Start
// gesture for the message url (request + onAdded) unless `fresh: false`, which
// models a stale grant that exists without a current Start (added silently).
// `failRevoke` / `failUnregister` make the matching Chrome API reject, to
// model cleanup failures; both stay editable through `knobs` so a test can
// let a retry succeed. chrome.scripting is stateful too: `registeredIds` is
// what getRegisteredContentScripts answers from, seeded from `registered`
// (a registration a previous worker left behind).
/**
 * @param {{ session?: any, tab?: any, granted?: boolean, fresh?: boolean,
 *   failRevoke?: boolean, failUnregister?: boolean, failGetAll?: boolean,
 *   failContains?: boolean, ignoreRemove?: boolean,
 *   registered?: string[], held?: string[] }} [options]
 */
export function makeBgMock({
  session,
  tab,
  granted = true,
  fresh = true,
  failRevoke = false,
  failUnregister = false,
  failGetAll = false,
  failContains = false,
  ignoreRemove = false,
  registered = [],
  held = [],
} = {}) {
  // `ignoreRemove`: permissions.remove resolves normally but Chrome keeps the
  // grant (a removal that did not take), so only a verification read sees it.
  const knobs = {
    failRevoke,
    failUnregister,
    failGetAll,
    failContains,
    ignoreRemove,
  };
  const platformInfoCalls = [];
  const onTabRemoved = eventHub();
  const onTabUpdated = eventHub();
  // Tabs `closeTab` has closed: as in Chrome, tabs.get rejects for them, so a
  // worker that never saw the onRemoved event (it was not running) still
  // learns the tab is gone when it asks.
  const closedTabs = new Set();
  // Each executeScript injection lands in a fresh document id (Chrome's
  // InjectionResult.documentId); tabs.sendMessage records the options it was
  // addressed with so a test can prove the reply was bound to that document.
  let documentSerial = 0;
  const onMessage = eventHub();
  const sessionStore = storageArea(session);
  const localStore = storageArea();
  const sent = [];
  const notifications = [];
  const syncSet = [];
  const tabMessages = [];
  const scripting = { registered: [], executed: [], unregistered: [] };
  const permissionRequests = [];
  const permissionRemovals = [];
  // `held` models optional host grants Chrome kept from a previous worker or
  // browser session (Chrome persists them): present before this worker starts.
  const grants = new Set(held);
  const registeredIds = new Set(registered);
  const onPermissionAdded = eventHub();
  const onPermissionRemoved = eventHub();

  const chrome = {
    i18n: {
      getMessage: (key, substitutions = []) => {
        const catalog = JSON.parse(
          readFileSync(
            new URL("../../_locales/en/messages.json", import.meta.url),
            "utf8",
          ),
        );
        const entry = catalog[key];
        if (!entry) return "";
        return entry.message.replace(/\$(\w+)\$/g, (_match, name) => {
          const position =
            Number(entry.placeholders[name.toLowerCase()].content.slice(1)) - 1;
          return substitutions[position];
        });
      },
    },
    runtime: {
      id: "test-extension-id",
      onInstalled: eventHub().api,
      onStartup: eventHub().api,
      onSuspend: eventHub().api,
      onMessage: onMessage.api,
      sendMessage: (msg) => {
        sent.push(msg);
        return Promise.resolve(undefined);
      },
      // The MV3 keepalive beat background.js uses while a Start is pending.
      getPlatformInfo: async () => {
        platformInfoCalls.push(Date.now());
        return { os: "linux", arch: "x86-64", nacl_arch: "x86-64" };
      },
    },
    storage: {
      session: sessionStore.area,
      local: localStore.area,
      sync: {
        set: async (obj) => {
          syncSet.push(obj);
        },
      },
    },
    debugger: {
      onEvent: eventHub().api,
      onDetach: eventHub().api,
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({}),
    },
    tabs: {
      onRemoved: onTabRemoved.api,
      onUpdated: onTabUpdated.api,
      get: async (id) => {
        if (tab && typeof tab.get === "function") return tab.get(id);
        if (closedTabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        return tab ? { id, url: tab.url } : { id };
      },
      sendMessage: async (id, message, options) => {
        tabMessages.push({ id, message, options });
        if (tab && typeof tab.sendMessage === "function")
          return tab.sendMessage(id, message, options);
        if (tab && typeof tab.token === "string")
          return {
            ok: true,
            token: tab.token,
            origin: new URL(tab.url).origin,
          };
        return { ok: false };
      },
    },
    notifications: {
      create: (opts) => {
        notifications.push(opts);
      },
    },
    permissions: {
      onAdded: onPermissionAdded.api,
      onRemoved: onPermissionRemoved.api,
      // Chrome answers with everything it holds, required and optional alike.
      // The startup sweep reads this to find grants a previous worker left.
      getAll: async () => {
        if (knobs.failGetAll) throw new Error("permissions.getAll failed");
        return {
          permissions: ["tabs", "storage", "scripting"],
          origins: ["https://backend-spring-lake-3890.fly.dev/*", ...grants],
        };
      },
      contains: async ({ origins }) => {
        if (knobs.failContains) throw new Error("permissions.contains failed");
        return Array.isArray(origins) && origins.every((o) => grants.has(o));
      },
      // The popup's Start-gesture prompt; records what was asked for. On
      // acceptance Chrome holds the grant and announces it.
      request: async (request) => {
        permissionRequests.push(request);
        if (granted !== true) return false;
        for (const o of request.origins ?? []) grants.add(o);
        onPermissionAdded.emit({ origins: [...(request.origins ?? [])] });
        return true;
      },
      remove: async (request) => {
        permissionRemovals.push(request);
        if (knobs.failRevoke) throw new Error("permissions.remove failed");
        if (knobs.ignoreRemove) return false;
        for (const o of request.origins ?? []) grants.delete(o);
        onPermissionRemoved.emit({ origins: [...(request.origins ?? [])] });
        return true;
      },
    },
    scripting: {
      registerContentScripts: async (scripts) => {
        scripting.registered.push(...scripts);
        for (const script of scripts) registeredIds.add(script.id);
      },
      getRegisteredContentScripts: async (filter) =>
        [...registeredIds]
          .filter((id) => !filter?.ids || filter.ids.includes(id))
          .map((id) => ({ id })),
      /** @returns {Promise<Array<Record<string, unknown>>>} */
      executeScript: async (injection) => {
        scripting.executed.push(injection);
        documentSerial += 1;
        return [
          { frameId: 0, documentId: `doc-${documentSerial}`, result: null },
        ];
      },
      unregisterContentScripts: async (filter) => {
        scripting.unregistered.push(filter);
        if (knobs.failUnregister)
          throw new Error("unregisterContentScripts failed");
        for (const id of filter?.ids ?? []) registeredIds.delete(id);
      },
    },
  };

  // Model the popup's Start gesture for a start message: the coach accepts
  // Chrome's prompt for the tab origin. The production popup REGISTERS its
  // Start with the worker first and only then prompts (there is no ordering
  // dependency left), so the default `dispatch` sends the message and then
  // fires the grant — the reverse of r2's mock, which emitted onAdded before
  // dispatch and so assumed the old ordering in by construction.
  // `fresh: false` models a grant Chrome holds with no prompt behind it.
  function startGesture(message, sender = extensionPageSender) {
    if (message?.kind !== "start_import" && message?.kind !== "start_ingest") {
      return;
    }
    // A message without a parseable url models a malformed Start: no prompt.
    if (typeof message.url !== "string" || !URL.canParse(message.url)) return;
    const origin = new URL(message.url).origin;
    if (granted !== true) {
      // The coach declined Chrome's prompt (or no prompt could be shown): the
      // popup tells the worker its pending Start will never be granted, so
      // nothing waits out the window. Exactly what popup.js does.
      void dispatchRaw(
        { kind: "start_unavailable", nonce: message.nonce ?? null },
        sender,
      );
      return;
    }
    const pattern = `${origin}/*`;
    grants.add(pattern);
    // A real prompt acceptance ALWAYS announces itself (permissions.onAdded);
    // `fresh: false` models a grant Chrome already held, where request()
    // answers true with NO prompt and NO announcement. Either way the popup
    // reports Chrome's `true` back, exactly as popup.js does.
    if (fresh) onPermissionAdded.emit({ origins: [pattern] });
    void dispatchRaw(
      { kind: "start_granted", nonce: message.nonce ?? null },
      sender,
    );
  }

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
  // The real Start order: register with the worker, THEN accept the prompt —
  // and only when the registration was accepted. popup.js never prompts for a
  // Start the worker refused (busy, cleanup owed), so neither does this.
  function dispatch(message, sender = extensionPageSender) {
    return dispatchRaw(message, sender).then((ack) => {
      if (ack === undefined || ack.ok === true) startGesture(message, sender);
      return ack;
    });
  }
  // The other order (Chrome delivers the accepted grant before the popup's
  // message lands — a cold worker queues both): the run must still start.
  function dispatchGrantFirst(message, sender = extensionPageSender) {
    startGesture(message, sender);
    return dispatchRaw(message, sender);
  }
  // The same message with NO Start gesture: what an extension page sends when
  // it relies on a grant Chrome already holds.
  function dispatchRaw(message, sender = extensionPageSender) {
    return new Promise((resolve) => {
      let settled = false;
      const sendResponse = (r) => {
        settled = true;
        resolve(r);
      };
      const listener = onMessage.first();
      const kept = listener(message, sender, sendResponse);
      if (kept !== true && !settled) {
        resolve(undefined);
      }
    });
  }

  // Chrome delivers an accepted grant for `origin` with no popup involved
  // (the prompt closed the popup, or the grant came from Chrome's own UI).
  function grantArrives(origin) {
    const pattern = `${origin}/*`;
    grants.add(pattern);
    onPermissionAdded.emit({ origins: [pattern] });
  }

  // Chrome tab lifecycle events, as the worker sees them. `closeTab` with
  // `notify: false` models a tab that closed while NO worker was running: the
  // tab is gone (tabs.get rejects) but no onRemoved event is ever delivered.
  function closeTab(tabId, { notify = true } = {}) {
    closedTabs.add(tabId);
    if (notify)
      onTabRemoved.emit(tabId, { windowId: 1, isWindowClosing: false });
  }
  function navigateTab(tabId, url) {
    if (tab && typeof tab.url === "string") tab.url = url;
    onTabUpdated.emit(tabId, { url, status: "loading" }, { id: tabId, url });
  }

  return {
    chrome,
    dispatch,
    grantArrives,
    closeTab,
    navigateTab,
    platformInfoCalls,
    dispatchGrantFirst,
    dispatchRaw,
    // The popup's own Start gesture, driven alone: for a test that interleaves
    // work between the registration and the coach's accepted prompt.
    startGesture,
    sent,
    notifications,
    syncSet,
    tabMessages,
    scripting,
    permissionRequests,
    permissionRemovals,
    grants,
    registeredIds,
    knobs,
    sessionMap: sessionStore.map,
    localMap: localStore.map,
  };
}

export function installChrome(mock) {
  globalThis.chrome = mock.chrome;
}

// Match ScoutIngestResult instead of the previous empty-2xx test shortcut.
export function acceptedIngest(init, status = 202) {
  return Response.json(
    {
      received: JSON.parse(init.body).entities.length,
      deduped: 0,
    },
    { status },
  );
}
