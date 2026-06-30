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
chrome.runtime.onMessage.addListener((message) => {
    if (isSnapshot(message)) {
        render(message);
    }
});
chrome.runtime.sendMessage({ kind: "request_status" }, (response) => {
    if (isSnapshot(response)) {
        render(response);
    }
});
export {};
