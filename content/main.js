// Manifest-declared content scripts are classic scripts even when the service
// worker is a module. Keep this entrypoint self-contained, with no ES exports or
// test-only globals. Tests execute these exact bytes through the manifest.
(() => {
  if (
    typeof chrome === "undefined" ||
    !chrome.runtime ||
    typeof location === "undefined"
  ) {
    return;
  }
  const runtime = chrome.runtime;

  // Lazy access: storage can be denied, and authorization may happen after page
  // load. A JWT shape is only a credential candidate, not verified source identity.
  function readSourceBearer() {
    const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
    for (const name of ["sessionStorage", "localStorage"]) {
      try {
        const store = globalThis[name];
        for (let i = 0; i < store.length; i += 1) {
          const value = store.getItem(store.key(i));
          if (typeof value === "string" && JWT.test(value)) {
            return value;
          }
        }
      } catch {
        // A denied store is not a credential. Never expose its error.
        continue;
      }
    }
    return "";
  }

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender &&
      sender.id === runtime.id &&
      message &&
      message.kind === "collect_source_token"
    ) {
      const token = readSourceBearer();
      sendResponse(token.length > 0 ? { ok: true, token } : { ok: false });
    }
    return false;
  });
  runtime
    .sendMessage({ kind: "platform_tab_live", url: location.href })
    .catch(() => {
      // This classic entrypoint cannot import the module logger. Emit only a
      // fixed event, never a page URL, storage value or runtime error.
      console.warn(
        JSON.stringify({
          src: "tgp-importer",
          event: "source_tab_announcement_failed",
        }),
      );
    });
})();
