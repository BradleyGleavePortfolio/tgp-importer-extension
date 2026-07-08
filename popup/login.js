// TGP Importer — login handler.
//
// Submits email/password to POST /auth/extension/login, stores the token pair,
// then swaps the popup to the existing status view (popup.html). The
// "Create an Account →" link opens the TGP sign-up page in a new tab so account
// creation happens on the first-party web app (docs/DESIGN.md §2, §4).
//
// R75: zero banned type-assertions — every narrowing is a real guard. The
// access token is handed to the background worker (memory-only there); the
// refresh token lives in chrome.storage.session (memory-only, cleared when the
// browser session ends) — an extension holding the `debugger` permission must
// not persist credentials to disk.
import { TGP_API_ORIGIN } from "../shared/protocol.js";

const SIGNUP_URL = "https://app.tgp.coach/signup?ref=importer-extension";
const STORAGE_KEY_REFRESH = "tgp_refresh_token";

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
    // Keep the refresh token in session storage (memory-only) and hand the
    // access token to the worker. Neither credential ever touches disk.
    await chrome.storage.session.set({ [STORAGE_KEY_REFRESH]: refreshToken });
    chrome.runtime
        .sendMessage({ kind: "session_established", accessToken })
        .catch(() => undefined);
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
