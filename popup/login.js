// TGP Importer — login handler.
//
// Submits email/password to POST /auth/extension/login, stores the token pair,
// then swaps the popup to the existing status view (popup.html). The
// "Create an Account →" link opens the TGP sign-up page in a new tab so account
// creation happens on the first-party web app (docs/DESIGN.md §2, §4).
//
// R75: zero banned type-assertions — every narrowing is a real guard. The popup
// never owns session state: it hands the whole token pair to the background
// worker via one `session_established` message. The worker is the single owner —
// it holds the access token in memory and persists the refresh token to
// chrome.storage.session. The popup itself never touches chrome.storage, so an
// extension holding the `debugger` permission cannot persist credentials here.
import { TGP_API_ORIGIN } from "../shared/protocol.js";

const SIGNUP_URL = "https://app.tgp.coach/signup?ref=importer-extension";

function el(id) {
    const node = document.getElementById(id);
    if (!node) {
        throw new Error(`missing element #${id}`);
    }
    return node;
}

function readString(record, key) {
    return typeof record === "object" &&
        record !== null &&
        typeof record[key] === "string"
        ? record[key]
        : null;
}

function isOk(value) {
    return typeof value === "object" && value !== null && value.ok === true;
}

function showError(message) {
    const box = el("error");
    box.hidden = false;
    box.textContent = message;
}

async function submitLogin(email, password) {
    const res = await fetch(`${TGP_API_ORIGIN}/auth/extension/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
        throw new Error(res.status === 401 ? "Invalid email or password." : `Sign-in failed (${res.status}).`);
    }
    const body = await res.json();
    const accessToken = readString(body, "access_token");
    const refreshToken = readString(body, "refresh_token");
    if (accessToken === null || refreshToken === null) {
        throw new Error("Unexpected sign-in response.");
    }
    // Hand the whole token pair to the background worker — the single owner of
    // session state. It holds the access token in memory and persists the
    // refresh token to chrome.storage.session. Fail-closed: only proceed once
    // the worker acknowledges the session was established.
    const ack = await chrome.runtime.sendMessage({
        kind: "session_established",
        accessToken,
        refreshToken,
    });
    if (!isOk(ack)) {
        throw new Error("Could not establish session. Please try again.");
    }
}

const form = el("login-form");
form.addEventListener("submit", (event) => {
    event.preventDefault();
    const submit = el("submit");
    const email = el("email");
    const password = el("password");
    const emailValue = email instanceof HTMLInputElement ? email.value : "";
    const passwordValue = password instanceof HTMLInputElement ? password.value : "";
    if (submit instanceof HTMLButtonElement) {
        submit.disabled = true;
    }
    void submitLogin(emailValue, passwordValue)
        .then(() => {
            // Swap to the existing status view now that a session exists.
            window.location.href = "popup.html";
        })
        .catch((err) => {
            showError(err instanceof Error ? err.message : "Sign-in failed.");
            if (submit instanceof HTMLButtonElement) {
                submit.disabled = false;
            }
        });
});

el("signup").addEventListener("click", (event) => {
    event.preventDefault();
    void chrome.tabs.create({ url: SIGNUP_URL });
});

export {};
