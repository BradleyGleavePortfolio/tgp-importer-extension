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
        value.textContent = `${p.sent} / ${p.total}`;
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
chrome.runtime.onMessage.addListener((message) => {
    if (isSnapshot(message)) {
        render(message);
    }
});
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
export {};
