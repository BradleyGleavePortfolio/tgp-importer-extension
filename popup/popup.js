// TGP Importer — popup status UI.
// Requests a snapshot from the background worker and renders intent +
// per-entity progress + the last error. Re-renders on every broadcast.
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
        // The autonomous crawl cannot know a total up front, so onProgress rows
        // carry only `sent`; the mapped extractor still reports a total. Show the
        // ratio when a total exists, otherwise just the running sent count.
        value.textContent = typeof p.total === "number" ? `${p.sent} / ${p.total}` : `${p.sent}`;
        row.appendChild(label);
        row.appendChild(value);
        list.appendChild(row);
    }
}
function render(snapshot) {
    const empty = el("empty");
    const detail = el("detail");
    const errorBox = el("error");
    if (!snapshot.intent) {
        empty.hidden = false;
        detail.hidden = true;
    }
    else {
        empty.hidden = true;
        detail.hidden = false;
        el("intent-id").textContent = snapshot.intent.intentId;
        el("platform").textContent = snapshot.intent.platform;
        const status = el("status");
        status.textContent = snapshot.intent.status;
        status.className = `status-${snapshot.intent.status}`;
        renderProgress(snapshot);
    }
    if (snapshot.lastError) {
        errorBox.hidden = false;
        errorBox.textContent = snapshot.lastError;
    }
    else {
        errorBox.hidden = true;
    }
}
function isOk(value) {
    return typeof value === "object" && value !== null && value.ok === true;
}

// Ask the background worker to begin an autonomous import of the ACTIVE tab.
// The active tab's URL is the only input: the worker detects the platform,
// resolves its blueprint, and injects that tab's origin as the crawl allowlist.
// Exported so a test can drive the REAL send path (not a source grep).
export function requestStartImport(runtime, tabs) {
    return tabs.query({ active: true, currentWindow: true }).then((result) => {
        const tab = Array.isArray(result) && result.length > 0 ? result[0] : null;
        const url = tab && typeof tab.url === "string" ? tab.url : "";
        return runtime.sendMessage({ kind: "start_import", url });
    });
}

// Wire the Start Import CTA. Disables the button for the duration of the send so
// a double-click cannot fire two start_import messages (the worker also enforces
// single-flight); re-enables it when the send settles. Exported + dependency-
// injected so a test exercises the actual click handler with a fake button.
export function wireStartImport(runtime, tabs, doc) {
    const btn = doc.getElementById("start-import");
    if (!btn) {
        return;
    }
    btn.addEventListener("click", () => {
        btn.disabled = true;
        requestStartImport(runtime, tabs).catch(() => undefined).then(() => { btn.disabled = false; });
    });
}

// Bootstrap only in a real extension page (chrome + DOM present). Guarded so the
// module can be imported under test to exercise the exported functions without
// firing the load-time routing side effects.
if (typeof chrome !== "undefined" && chrome.runtime && typeof document !== "undefined") {
    chrome.runtime.onMessage.addListener((message) => {
        if (isSnapshot(message)) {
            render(message);
        }
    });
    wireStartImport(chrome.runtime, chrome.tabs, document);
    // Route first: with no session, the only path forward is the pairing view
    // (docs/DESIGN.md §2). Otherwise render the live import status.
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
