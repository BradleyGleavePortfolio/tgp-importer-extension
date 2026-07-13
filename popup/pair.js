// TGP Importer — pairing view controller.
//
// The extension's ONLY sign-in surface (docs/DESIGN.md §2 step 6): a single
// 6-digit code the coach mints in the TGP mobile app. No email, no password,
// no signup link. All token handling lives in shared/pairing.js (redeem) and
// the background worker (the single session owner); this file only wires the
// DOM and swaps to the status view once a session exists.
import { redeemPairingCode } from "../shared/pairing.js";
import { PAIRING_ENABLED } from "../shared/protocol.js";

function el(id) {
    const node = document.getElementById(id);
    if (!node) {
        throw new Error(`missing element #${id}`);
    }
    return node;
}
function isOk(value) {
    return typeof value === "object" && value !== null && value.ok === true;
}
function showError(message) {
    const box = el("error");
    box.hidden = false;
    box.textContent = message;
}
function disableSubmit(disabled) {
    const submit = el("submit");
    if (submit instanceof HTMLButtonElement) {
        submit.disabled = disabled;
    }
}

// If a session already exists, skip pairing and go straight to the status view.
chrome.runtime.sendMessage({ kind: "request_session_state" }, (response) => {
    if (isOk(response) && response.hasSession === true) {
        window.location.replace("popup.html");
    }
});

// PAIRING_ENABLED ships ON for the v0.3 RC (its backend contract is merged —
// shared/protocol.js). This guard is retained so that if the flag is ever
// flipped off in lockstep with a backend rollback, the coach sees an honest
// "not available yet" state rather than a form that fires at a dead endpoint.
if (!PAIRING_ENABLED) {
    disableSubmit(true);
    showError("Pairing isn't available yet — it unlocks once the TGP backend ships pairing.");
}

el("pair-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = el("code");
    const code = input instanceof HTMLInputElement ? input.value.trim() : "";
    disableSubmit(true);
    void redeemPairingCode(code).then((result) => {
        if (isOk(result)) {
            window.location.replace("popup.html");
            return;
        }
        showError(result.error);
        disableSubmit(false);
    });
});

export {};
