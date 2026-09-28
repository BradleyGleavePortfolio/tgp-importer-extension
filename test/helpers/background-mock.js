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
 *   failRevoke?: boolean, failUnregister?: boolean, registered?: string[] }} [options]
 */
export function makeBgMock({
  session,
  tab,
  granted = true,
  fresh = true,
  failRevoke = false,
  failUnregister = false,
  registered = [],
} = {}) {
  const knobs = { failRevoke, failUnregister };
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
  const grants = new Set();
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
      onRemoved: eventHub().api,
      onUpdated: eventHub().api,
      get: async (id) => {
        if (tab && typeof tab.get === "function") return tab.get(id);
        return tab ? { id, url: tab.url } : { id };
      },
      sendMessage: async (id, message) => {
        tabMessages.push({ id, message });
        if (tab && typeof tab.sendMessage === "function")
          return tab.sendMessage(id, message);
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
      contains: async ({ origins }) =>
        Array.isArray(origins) && origins.every((o) => grants.has(o)),
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
      executeScript: async (injection) => {
        scripting.executed.push(injection);
        return [];
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
  // Chrome's prompt for the tab origin just before the worker is asked.
  function startGesture(message) {
    if (message?.kind !== "start_import" && message?.kind !== "start_ingest") {
      return;
    }
    // A message without a parseable url models a malformed Start: no prompt.
    if (typeof message.url !== "string" || !URL.canParse(message.url)) return;
    const origin = new URL(message.url).origin;
    if (granted !== true) return;
    const pattern = `${origin}/*`;
    if (fresh) {
      grants.add(pattern);
      onPermissionAdded.emit({ origins: [pattern] });
    } else {
      grants.add(pattern); // held by Chrome, but no Start announced it
    }
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
  function dispatch(message, sender = extensionPageSender) {
    startGesture(message);
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

  return {
    chrome,
    dispatch,
    dispatchRaw,
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
