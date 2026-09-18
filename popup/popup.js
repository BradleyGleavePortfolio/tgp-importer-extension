// TGP Importer — popup status UI.
// Requests a snapshot from the background worker and renders intent +
// per-entity progress + the last error. Re-renders on every broadcast.
import { outcomeView } from "./outcome.js";

let latestSnapshot = null;
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
  return "kind" in value && value.kind === "status_snapshot";
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
  latestSnapshot = snapshot;
  const empty = el("empty");
  const detail = el("detail");
  const errorBox = el("error");
  const start = el("start-import");
  start.dataset.outcomeLocked = snapshot.intent ? "true" : "false";
  if ("disabled" in start) start.disabled = Boolean(snapshot.intent);
  if (!snapshot.intent) {
    empty.hidden = false;
    detail.hidden = true;
  } else {
    empty.hidden = true;
    detail.hidden = false;
    el("intent-id").textContent = snapshot.intent.intentId;
    el("platform").textContent = snapshot.intent.platform;
    const view = outcomeView(snapshot, chrome.i18n.getMessage);
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
  if (snapshot.lastError && !snapshot.intent) {
    errorBox.hidden = false;
    errorBox.textContent = snapshot.lastError;
  } else {
    errorBox.hidden = true;
  }
}
function isOk(value) {
  return typeof value === "object" && value !== null && value.ok === true;
}

// Ask the worker to import the ACTIVE tab; its URL is the only input (the worker
// detects platform, resolves blueprint, injects origin allowlist). Exported so a
// test can drive the REAL send path.
export function requestStartImport(runtime, tabs) {
  return tabs.query({ active: true, currentWindow: true }).then((result) => {
    const tab = Array.isArray(result) && result.length > 0 ? result[0] : null;
    const url = tab && typeof tab.url === "string" ? tab.url : "";
    // The tab id lets the worker ask this tab's content script for the source
    // bearer; the popup never sees or handles the token.
    const tabId = tab && typeof tab.id === "number" ? tab.id : null;
    return runtime.sendMessage({ kind: "start_import", url, tabId });
  });
}

// Wire the Start Import CTA. Disables the button while the send is in flight so a
// double-click cannot fire two messages (the worker also enforces single-flight);
// re-enables on settle. Exported + injected so a test drives the real handler.
export function wireStartImport(
  runtime,
  tabs,
  doc,
  getMessage = (key) => chrome.i18n.getMessage(key),
) {
  const btn = doc.getElementById("start-import");
  if (!btn) {
    return;
  }
  function showUnconfirmedStart() {
    const errorBox = doc.getElementById("error");
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = getMessage("start_import_unconfirmed");
    }
  }
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    btn.disabled = true;
    requestStartImport(runtime, tabs)
      .then((response) => {
        if (!isOk(response)) showUnconfirmedStart();
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

export function wireOutcomeActions(runtime, doc, clipboard, message, receive) {
  const feedback = doc.getElementById("action-feedback");
  doc.getElementById("check-status").addEventListener("click", async () => {
    try {
      const snapshot = await runtime.sendMessage({ kind: "request_status" });
      if (!isSnapshot(snapshot)) throw new Error("status_unavailable");
      receive(snapshot);
      feedback.textContent = message("outcome_checked");
    } catch {
      feedback.textContent = message("outcome_check_failed");
    }
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
  chrome.runtime.onMessage.addListener((message) => {
    if (isSnapshot(message)) {
      render(message);
    }
  });
  wireStartImport(chrome.runtime, chrome.tabs, document);
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
  chrome.runtime.sendMessage({ kind: "request_session_state" }, (response) => {
    if (isOk(response) && response.hasSession !== true) {
      window.location.replace("pair.html");
      return;
    }
    chrome.runtime.sendMessage({ kind: "request_status" }, (snapshot) => {
      if (isSnapshot(snapshot)) {
        render(snapshot);
      }
    });
  });
}
