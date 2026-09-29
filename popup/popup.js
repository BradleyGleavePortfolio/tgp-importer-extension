// TGP Importer — popup status UI.
// Requests a snapshot from the background worker and renders intent +
// per-entity progress + the last error. Re-renders on every broadcast.
import { outcomeView, preStartIssue, serverStatusView } from "./outcome.js";
import { isTgpOrigin } from "../shared/protocol.js";

let latestSnapshot = null;
let snapshotVersion = 0;
let serverCheckVersion = 0;
function el(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`missing element #${id}`);
  }
  return node;
}
function isSnapshot(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    value.kind === "status_snapshot" &&
    (value.intent === null ||
      (typeof value.intent === "object" &&
        value.intent !== null &&
        ["intentId", "platform", "status"].every(
          (key) => typeof value.intent[key] === "string",
        ))) &&
    Array.isArray(value.progress) &&
    value.progress.every(
      (row) =>
        row &&
        typeof row.entityType === "string" &&
        Number.isSafeInteger(row.sent) &&
        row.sent >= 0 &&
        (row.total === undefined ||
          (Number.isSafeInteger(row.total) && row.total >= 0)),
    ) &&
    (value.lastError == null || typeof value.lastError === "string")
  );
}
function renderProgress(snapshot) {
  const list = el("progress-list");
  list.textContent = "";
  for (const p of snapshot.progress) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = p.entityType;
    const value = document.createElement("span");
    // The crawl has no total up front, so show the ratio only when one exists.
    const staged = snapshot.staging?.[p.entityType];
    value.textContent = staged
      ? chrome.i18n.getMessage("replay_staging_counts", [
          String(staged.received),
          String(staged.inserted),
          String(staged.deduped),
        ])
      : typeof p.total === "number"
        ? `${p.sent} / ${p.total}`
        : `${p.sent}`;
    row.appendChild(label);
    row.appendChild(value);
    list.appendChild(row);
  }
}
function render(snapshot) {
  if (!isSnapshot(snapshot)) throw new Error("status_unavailable");
  const view = snapshot.intent
    ? outcomeView(snapshot, chrome.i18n.getMessage)
    : null;
  latestSnapshot = snapshot;
  snapshotVersion += 1;
  const empty = el("empty");
  const detail = el("detail");
  const errorBox = el("error");
  const start = el("start-import");
  start.dataset.outcomeLocked = snapshot.intent ? "true" : "false";
  if ("disabled" in start) start.disabled = Boolean(snapshot.intent);
  el("outcome-actions").hidden = !snapshot.intent;
  el("copy-summary").hidden = !snapshot.intent;
  if (!snapshot.intent) {
    empty.hidden = false;
    empty.textContent = chrome.i18n.getMessage("outcome_ready");
    detail.hidden = true;
  } else {
    empty.hidden = true;
    detail.hidden = false;
    el("intent-id").textContent = snapshot.intent.intentId;
    el("platform").textContent = snapshot.intent.platform;
    el("status").textContent = view.title;
    el("outcome-coverage").textContent = view.coverage;
    el("outcome-native").textContent = view.native;
    el("outcome-guidance").textContent = view.guidance;
    el("outcome-no-receipt").textContent = view.noReceipt;
    el("outcome-issue").textContent = view.issue;
    const list = el("progress-list");
    list.textContent = "";
    if (view.lines.length === 0) renderProgress(snapshot);
    for (const line of view.lines) {
      const row = document.createElement("section");
      row.className = "transfer-family";
      for (const [tag, text] of [
        ["h3", line.label],
        ["p", line.receipt],
        ["p", line.unconfirmed],
      ]) {
        if (!text) continue;
        const node = document.createElement(tag);
        node.textContent = text;
        row.appendChild(node);
      }
      list.appendChild(row);
    }
  }
  // A server record belongs to exactly one run: drop it when the run on screen
  // changes, so another run's server counts are never shown under this one.
  const server = document.getElementById("server-status");
  if (server && server.dataset.intentId !== snapshot.intent?.intentId)
    paintServerStatus(document, null);
  if (snapshot.lastError && !snapshot.intent) {
    errorBox.hidden = false;
    // Approved fact+remedy copy only; the raw worker-internal lastError (which
    // can include a platform slug or tab origin) never reaches the coach.
    errorBox.textContent = preStartIssue(
      snapshot.lastError,
      chrome.i18n.getMessage,
    );
  } else {
    errorBox.hidden = true;
  }
}
function isOk(value) {
  return typeof value === "object" && value !== null && value.ok === true;
}

// Authorization = Start. The https origin of the ACTIVE tab is the only site
// this run may touch; nothing else is authorized. Returns null for anything
// that is not an https page (chrome://, file://, http://, no tab).
function sourceOriginOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" ? parsed.origin : null;
}

// Stable pre-start codes decided in the popup, before the worker is asked.
const START_ISSUE_CODES = new Set([
  "origin_not_https",
  "origin_is_tgp",
  "origin_not_authorized",
  "origin_request_failed",
  "source_tab_required",
]);

// On the Start gesture, in this order and for this reason:
//   1. REGISTER the Start with the worker (tab id, tab origin, a nonce). This
//      happens BEFORE Chrome is prompted, so there is no ordering dependency
//      left: the worker begins the run as soon as both the pending Start and a
//      fresh grant for that exact origin exist, in EITHER order.
//   2. Ask Chrome for that one origin. Chrome's prompt takes focus and may
//      close this popup; the run still proceeds, because the worker already
//      holds the registration and will see the grant event.
// Denial (or an unavailable prompt) is reported back so the worker can end its
// pending Start at once instead of waiting out the window. The worker never
// trusts the popup's claim: it re-checks the grant with Chrome, holds the
// origin for the run, and collects the source bearer itself — the popup never
// handles the token.
export function requestStartImport(runtime, tabs, permissions) {
  return tabs.query({ active: true, currentWindow: true }).then((result) => {
    const tab = Array.isArray(result) && result.length > 0 ? result[0] : null;
    const url = tab && typeof tab.url === "string" ? tab.url : "";
    const tabId = tab && typeof tab.id === "number" ? tab.id : null;
    const origin = sourceOriginOf(url);
    if (origin === null) {
      return { ok: false, error: "origin_not_https" };
    }
    if (isTgpOrigin(origin)) {
      return { ok: false, error: "origin_is_tgp" };
    }
    // R35-c7A-01: a Start binds the grant and the run to ONE live tab. A tab
    // Chrome will not identify cannot be that tab, so nothing is registered
    // and Chrome is never prompted.
    if (tabId === null) {
      return { ok: false, error: "source_tab_required" };
    }
    const nonce = startNonce();
    return runtime
      .sendMessage({ kind: "start_import", url, tabId, nonce })
      .then((ack) => {
        // A refused registration (busy, cleanup owed) starts nothing and must
        // not lead to a prompt the coach cannot use.
        if (!isOk(ack)) return ack;
        // Chrome's prompt answers true (granted), false (declined) or rejects
        // (no gesture, prompt unavailable). Each is its own honest no-run fact,
        // and each tells the worker to drop the Start it registered.
        return permissions.request({ origins: [`${origin}/*`] }).then(
          (granted) =>
            granted === true
              ? confirmStart(runtime, nonce, ack)
              : abandonStart(runtime, nonce, "origin_not_authorized"),
          () => abandonStart(runtime, nonce, "origin_request_failed"),
        );
      });
  });
}

// Tell the worker its pending Start will never be granted, then report the
// honest code. A lost cancellation is not fatal: the worker expires the
// pending Start (and revokes any grant) on its own deadline.
function abandonStart(runtime, nonce, error) {
  const refused = { ok: false, error };
  return Promise.resolve(
    runtime.sendMessage({ kind: "start_unavailable", nonce }),
  ).then(
    () => refused,
    // The worker was not reachable; its own deadline ends the Start.
    () => refused,
  );
}

// Chrome answered `true`. If the coach accepted a PROMPT, the worker's grant
// event has already started the run and this is a no-op. If Chrome answered
// true because it ALREADY held the origin, no prompt and no grant event
// happened: the worker refuses that (possession is not a Start) and revokes
// it, and the reply carries that fact so the popup shows the honest line.
function confirmStart(runtime, nonce, ack) {
  return Promise.resolve(runtime.sendMessage({ kind: "start_granted", nonce }))
    .then((reply) => (isOk(reply) ? ack : reply))
    .catch(() => ack);
}

// Opaque one-time id binding this gesture's registration to this gesture's
// grant. Not a secret and never leaves the extension.
function startNonce() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `start-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Wire the Start Import CTA. Disables the button while the send is in flight so a
// double-click cannot fire two messages (the worker also enforces single-flight);
// re-enables on settle. Exported + injected so a test drives the real handler.
export function wireStartImport(
  runtime,
  tabs,
  doc,
  getMessage = (key) => chrome.i18n.getMessage(key),
  permissions = undefined,
) {
  const btn = doc.getElementById("start-import");
  if (!btn) {
    return;
  }
  function showStartIssue(text) {
    const errorBox = doc.getElementById("error");
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = text;
    }
  }
  function showUnconfirmedStart() {
    showStartIssue(getMessage("start_import_unconfirmed"));
  }
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    btn.disabled = true;
    requestStartImport(runtime, tabs, permissions)
      .then((response) => {
        if (isOk(response)) return;
        // A code the popup itself decided is an honest no-run fact: approved
        // copy for it, never the raw code. Anything else stays "unconfirmed".
        const code =
          response && typeof response.error === "string" ? response.error : "";
        if (START_ISSUE_CODES.has(code)) {
          showStartIssue(preStartIssue(code, getMessage));
        } else {
          showUnconfirmedStart();
        }
      })
      .catch(() => {
        // A lost reply is not proof that Start was rejected or that no records
        // were written. Do not encourage a blind retry or expose the error.
        showUnconfirmedStart();
      })
      .finally(() => {
        btn.disabled = btn.dataset?.outcomeLocked === "true";
      });
  });
}

// Paint the separate "TGP server record" region, or hide and clear it (null).
// Display only: never touches Start, its lock, the snapshot or the receipts.
export function paintServerStatus(doc, view) {
  const region = doc.getElementById("server-status");
  if (!region) return;
  const state = doc.getElementById("server-status-state");
  const families = doc.getElementById("server-status-families");
  region.hidden = view === null;
  region.dataset.intentId = view === null ? "" : view.intentId;
  if (state) state.textContent = view === null ? "" : view.state;
  if (!families) return;
  families.textContent = "";
  for (const line of view === null ? [] : view.lines) {
    const row = doc.createElement("div");
    row.className = "row";
    const label = doc.createElement("span");
    label.className = "label";
    label.textContent = line.label;
    const value = doc.createElement("span");
    value.textContent = line.text;
    row.appendChild(label);
    row.appendChild(value);
    families.appendChild(row);
  }
}

// Check status, second half: ask the worker to read the server for its own
// run. Runs after the local refresh; a newer check supersedes an older reply.
async function checkServerStatus(runtime, doc, message) {
  const version = ++serverCheckVersion;
  let reply;
  try {
    reply = await runtime.sendMessage({ kind: "request_server_status" });
  } catch {
    reply = { kind: "server_status", state: "unavailable" };
  }
  if (version !== serverCheckVersion) return;
  paintServerStatus(doc, serverStatusView(reply, latestSnapshot, message));
}

export function wireOutcomeActions(runtime, doc, clipboard, message, receive) {
  const feedback = doc.getElementById("action-feedback");
  async function checkLocalStatus() {
    const version = snapshotVersion;
    try {
      const snapshot = await runtime.sendMessage({ kind: "request_status" });
      if (version !== snapshotVersion) return;
      if (!isSnapshot(snapshot)) throw new Error("status_unavailable");
      receive(snapshot);
      feedback.textContent = message("outcome_checked");
    } catch {
      if (version !== snapshotVersion) return;
      feedback.textContent = message("outcome_check_failed");
    }
  }
  doc.getElementById("check-status").addEventListener("click", async () => {
    await checkLocalStatus();
    await checkServerStatus(runtime, doc, message);
  });
  doc.getElementById("copy-summary").addEventListener("click", async () => {
    try {
      if (!latestSnapshot?.intent) throw new Error("no_result");
      await clipboard.writeText(outcomeView(latestSnapshot, message).summary);
      feedback.textContent = message("outcome_copied");
    } catch {
      feedback.textContent = message("outcome_copy_failed");
    }
  });
}

// Bootstrap only in a real extension page (chrome + DOM present); guarded so the
// module can be imported under test without firing load-time side effects.
if (
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  typeof document !== "undefined"
) {
  const start = el("start-import");
  start.dataset.outcomeLocked = "true";
  if ("disabled" in start) start.disabled = true;
  el("empty").textContent = chrome.i18n.getMessage("outcome_loading");
  el("outcome-actions").hidden = false;
  el("copy-summary").hidden = true;
  chrome.runtime.onMessage.addListener((message) => {
    if (isSnapshot(message)) {
      render(message);
    }
  });
  wireStartImport(
    chrome.runtime,
    chrome.tabs,
    document,
    (key) => chrome.i18n.getMessage(key),
    chrome.permissions,
  );
  wireOutcomeActions(
    chrome.runtime,
    document,
    typeof navigator === "undefined" ? undefined : navigator.clipboard,
    chrome.i18n.getMessage,
    render,
  );
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = chrome.i18n.getMessage(node.getAttribute("data-i18n"));
  }
  // Route first: with no session the only path forward is the pairing view.
  const bootstrapVersion = snapshotVersion;
  const unavailable = () => {
    if (snapshotVersion === bootstrapVersion) {
      el("empty").textContent = chrome.i18n.getMessage(
        "outcome_status_unavailable",
      );
    }
  };
  const initialRequest = (request, receive) => {
    try {
      chrome.runtime.sendMessage(request, receive)?.catch(unavailable);
    } catch {
      unavailable();
    }
  };
  initialRequest({ kind: "request_session_state" }, (response) => {
    if (isOk(response) && response.hasSession !== true) {
      window.location.replace("pair.html");
      return;
    }
    if (snapshotVersion !== bootstrapVersion) return;
    if (!isOk(response)) {
      unavailable();
      return;
    }
    initialRequest({ kind: "request_status" }, (snapshot) => {
      if (snapshotVersion !== bootstrapVersion) return;
      if (isSnapshot(snapshot)) render(snapshot);
      else unavailable();
    });
  });
}
