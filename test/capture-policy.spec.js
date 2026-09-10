import { describe, it, expect, beforeEach } from "vitest";
import { makeChromeMock, installChrome } from "./helpers/chrome-mock.js";
import {
    ALLOWED_CAPTURE_HOSTS,
    BODY_REDACTED,
    assertCaptureTabAllowed,
    redactResponseBody,
} from "../shared/capture-policy.js";
import { attachDebugger, stopCapture } from "../shared/capture.js";
import { normalizeCaptureSnapshot } from "../shared/blueprint/input.js";

const TAB = 21;

describe("assertCaptureTabAllowed — debugger origin allowlist", () => {
    let mock;
    beforeEach(() => {
        mock = makeChromeMock();
        installChrome(mock);
    });

    async function expectRejected(url, code) {
        mock.setTabUrl(TAB, url);
        await expect(assertCaptureTabAllowed(TAB)).rejects.toThrow(code);
    }

    it("rejects a chrome:// internal page", async () => {
        await expectRejected("chrome://newtab", "capture_non_https");
    });

    it("rejects a chrome-extension:// page", async () => {
        await expectRejected("chrome-extension://xyz/popup.html", "capture_non_https");
    });

    it("rejects a devtools:// page", async () => {
        await expectRejected("devtools://devtools/bundled/inspector.html", "capture_non_https");
    });

    it("rejects a file:// URL", async () => {
        await expectRejected("file:///home/user/", "capture_non_https");
    });

    it("rejects plain-HTTP localhost (non-HTTPS)", async () => {
        await expectRejected("http://localhost:3000/", "capture_non_https");
    });

    it("rejects an HTTPS host that is not allowlisted", async () => {
        await expectRejected("https://evil.example.com/", "capture_host_not_allowed");
    });

    it("rejects the TGP auth surface — the importer never self-captures", async () => {
        await expectRejected("https://api.thegrowthproject.app/", "capture_host_not_allowed");
    });

    it("rejects a tab with no url property", async () => {
        mock.setTabUrl(TAB, null);
        await expect(assertCaptureTabAllowed(TAB)).rejects.toThrow("capture_no_url");
    });

    it("rejects a malformed tab url", async () => {
        await expectRejected("not a url at all", "capture_bad_url");
    });

    it("accepts an allowlisted HTTPS TrueCoach tab and returns the tab", async () => {
        mock.setTabUrl(TAB, "https://app.truecoach.co/clients");
        const tab = await assertCaptureTabAllowed(TAB);
        expect(tab).toMatchObject({ id: TAB, url: "https://app.truecoach.co/clients" });
    });

    it("keeps the allowlist HTTPS-hostname based (no scheme/wildcard entries)", () => {
        expect(ALLOWED_CAPTURE_HOSTS.has("app.truecoach.co")).toBe(true);
        for (const host of ALLOWED_CAPTURE_HOSTS) {
            expect(host).not.toContain("/");
            expect(host).not.toContain("*");
            expect(host).not.toContain(":");
        }
    });
});

describe("attachDebugger enforces the allowlist before any debugger call", () => {
    let mock;
    beforeEach(() => {
        mock = makeChromeMock();
        installChrome(mock);
    });

    it("refuses to attach to a non-allowlisted host and leaves no session", async () => {
        mock.setTabUrl(TAB, "https://evil.example.com/steal");
        await expect(attachDebugger(TAB)).rejects.toThrow("capture_host_not_allowed");
        // chrome.debugger.attach was never invoked and no listener leaked.
        expect(mock.calls.attach).toHaveLength(0);
        expect(mock.listenerCount()).toBe(0);
        expect(await stopCapture(TAB)).toEqual([]);
    });

    it("refuses to attach to a chrome:// tab", async () => {
        mock.setTabUrl(TAB, "chrome://extensions");
        await expect(attachDebugger(TAB)).rejects.toThrow();
        expect(mock.calls.attach).toHaveLength(0);
    });

    it("attaches normally to an allowlisted TrueCoach tab", async () => {
        mock.setTabUrl(TAB, "https://app.truecoach.co/clients");
        await attachDebugger(TAB);
        expect(mock.calls.attach).toEqual([{ target: { tabId: TAB }, version: "1.3" }]);
        await stopCapture(TAB);
    });
});

describe("redactResponseBody — auth/secret material is stripped, PII preserved", () => {
    it("redacts access_token while preserving nested client PII", () => {
        const input = JSON.stringify({ access_token: "xyz", client: { name: "A" } });
        const out = JSON.parse(redactResponseBody(input));
        expect(out.access_token).toBe(BODY_REDACTED);
        expect(out.client.name).toBe("A");
    });

    it("redacts every sensitive key in the denylist, case-insensitively", () => {
        const input = JSON.stringify({
            access_token: "a",
            refresh_token: "b",
            id_token: "c",
            token: "d",
            api_key: "e",
            Authorization: "f",
            COOKIE: "g",
            "set-cookie": "h",
            password: "i",
            secret: "j",
        });
        const out = JSON.parse(redactResponseBody(input));
        for (const value of Object.values(out)) {
            expect(value).toBe(BODY_REDACTED);
        }
    });

    it("walks nested objects and arrays", () => {
        const input = JSON.stringify({
            data: [{ session: { token: "leak" }, name: "Dana" }],
            meta: { auth: { refresh_token: "leak2" } },
        });
        const out = JSON.parse(redactResponseBody(input));
        expect(out.data[0].session).toBe(BODY_REDACTED);
        expect(out.data[0].name).toBe("Dana");
        expect(out.meta.auth).toBe(BODY_REDACTED);
    });

    it.each([
        "accessToken", "refreshToken", "auth_token", "client_secret", "sessionId",
        "session_token", "jwt", "x-api-key", "private_key", "password_hash", "credit_card",
    ])("shares the conservative credential alias classifier for %s", (key) => {
        const input = JSON.stringify({ [key]: "raw-secret", name: "Dana" });
        const out = JSON.parse(redactResponseBody(input));
        expect(out).toEqual({ [key]: BODY_REDACTED, name: "Dana" });
    });

    it.each(["\u0430ccess_token", "t\u03bfken"])(
        "redacts a mixed-script credential homoglyph key %s",
        (key) => {
            const sensitiveValue = "mixed-script-value-must-not-survive";
            const output = redactResponseBody(JSON.stringify({ [key]: sensitiveValue }));
            expect(JSON.parse(output)).toEqual({ [key]: BODY_REDACTED });
            expect(output).not.toContain(sensitiveValue);
        },
    );

    it.each(["metric_\u03b4elta", "\u043f\u0440\u043e\u0444\u0438\u043b\u044c_name", "na\u00efve_label"])(
        "preserves legitimate Unicode field %s",
        (key) => {
            const input = JSON.stringify({ [key]: "ordinary-data" });
            expect(redactResponseBody(input)).toBe(input);
        },
    );

    it("redacts credential-form strings nested under innocuous keys", () => {
        const input = JSON.stringify({
            message: "Bearer RAW-BEARER-SECRET",
            nested: { note: "eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.signature" },
        });
        const out = JSON.parse(redactResponseBody(input));
        expect(out).toEqual({
            message: BODY_REDACTED,
            nested: { note: BODY_REDACTED },
        });
    });

    it("redacts credential strings at the JSON root and every array depth", () => {
        const bearer = "Bearer RAW-ARRAY-SECRET";
        const basic = "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
        expect(redactResponseBody(JSON.stringify(bearer))).toBe(JSON.stringify(BODY_REDACTED));
        expect(JSON.parse(redactResponseBody(JSON.stringify([
            bearer, [basic], { values: ["Ｂｅａｒｅｒ FULLWIDTH-SECRET"] },
        ])))).toEqual([BODY_REDACTED, [BODY_REDACTED], { values: [BODY_REDACTED] }]);
    });

    it.each([
        "cardNumber", "cvv", "cvc", "pan", "pwd", "passwd", "passcode",
        "api_secret", "cookies",
    ])("redacts expanded credential/payment alias %s", (key) => {
        expect(JSON.parse(redactResponseBody(JSON.stringify({ [key]: "raw" }))))
            .toEqual({ [key]: BODY_REDACTED });
    });

    it.each(["tокеn", "pаsswоrԁ", "passwo\u200Brd", "pássword"])(
        "redacts normalized or multi-confusable credential key %s",
        (key) => expect(JSON.parse(redactResponseBody(JSON.stringify({ [key]: "raw" }))))
            .toEqual({ [key]: BODY_REDACTED }),
    );

    it("fails closed to a whole-body marker when the absolute walk budget is exceeded", () => {
        const input = JSON.stringify(Array.from({ length: 20001 }, () => null));
        expect(redactResponseBody(input)).toBe(JSON.stringify(BODY_REDACTED));
    });

    it("does NOT redact non-secret PII — names and emails survive verbatim", () => {
        const input = JSON.stringify({
            clients: [{ id: 7, name: "Dana Coach", email: "dana@example.com" }],
        });
        expect(redactResponseBody(input)).toBe(input);
    });

    it("does not clobber near-miss keys like token_count or secret_notes", () => {
        const input = JSON.stringify({ token_count: 3, secret_notes: "keep" });
        expect(redactResponseBody(input)).toBe(input);
    });

    it("preserves an untainted JSON body byte-for-byte", () => {
        const input = '{"clients":[{"id":7,"name":"Dana"}],"page":1}';
        expect(redactResponseBody(input)).toBe(input);
    });

    it("applies Bearer-token regex redaction to non-JSON bodies", () => {
        const input = "prefix Bearer abc.DEF-123_x suffix";
        expect(redactResponseBody(input)).toBe(`prefix ${BODY_REDACTED} suffix`);
    });

    it("applies JWT-shape regex redaction to non-JSON bodies", () => {
        const input = "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig&keep=1";
        expect(redactResponseBody(input)).toBe(`jwt=${BODY_REDACTED}&keep=1`);
    });

    it("redacts a JWT carried in a bare JSON string body", () => {
        const input = JSON.stringify("eyJhbGciOiJIUzI1NiJ9.payload.sig");
        expect(redactResponseBody(input)).toContain(BODY_REDACTED);
        expect(redactResponseBody(input)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    });

    it("passes through empty and non-string inputs unchanged", () => {
        expect(redactResponseBody("")).toBe("");
        expect(redactResponseBody(null)).toBe(null);
        expect(redactResponseBody(undefined)).toBe(undefined);
    });
});

describe("capture pipeline stores redacted bodies", () => {
    let mock;
    beforeEach(() => {
        mock = makeChromeMock();
        installChrome(mock);
    });

    function emitJson(requestId, url) {
        const source = { tabId: TAB };
        mock.emit(source, "Network.requestWillBeSent", {
            requestId,
            request: { url, method: "GET", headers: {} },
        });
        mock.emit(source, "Network.responseReceived", {
            requestId,
            response: { mimeType: "application/json", status: 200 },
        });
        mock.emit(source, "Network.loadingFinished", { requestId });
    }

    it("stores a token-bearing JSON body with the token redacted and PII intact", async () => {
        mock.onCommand("Network.getResponseBody", () => ({
            body: JSON.stringify({ access_token: "xyz", client: { name: "A" } }),
            base64Encoded: false,
        }));
        await attachDebugger(TAB);
        emitJson("red1", "https://app.truecoach.co/api/session");
        const [entry] = await stopCapture(TAB);
        const stored = JSON.parse(entry.responseBody);
        expect(stored.access_token).toBe(BODY_REDACTED);
        expect(stored.client.name).toBe("A");
        expect(entry.responseBody).not.toContain("xyz");
    });

    it("stores an untainted JSON body byte-for-byte", async () => {
        const body = '{"clients":[{"id":7,"name":"Dana"}],"page":1}';
        mock.onCommand("Network.getResponseBody", () => ({ body, base64Encoded: false }));
        await attachDebugger(TAB);
        emitJson("red2", "https://app.truecoach.co/api/clients");
        const [entry] = await stopCapture(TAB);
        expect(entry.responseBody).toBe(body);
    });

    it("produces credential-safe evidence across the real capture to C2a boundary", async () => {
        const raw = {
            accessToken: "live-access",
            client_secret: "live-client",
            message: "Bearer RAW-BEARER-SECRET",
            client: { name: "Dana" },
        };
        mock.onCommand("Network.getResponseBody", () => ({
            body: JSON.stringify(raw),
            base64Encoded: false,
        }));
        await attachDebugger(TAB);
        emitJson("red3", "https://app.truecoach.co/api/clients");
        const captured = await stopCapture(TAB);
        const result = normalizeCaptureSnapshot(captured);
        expect(result.excluded).toEqual([]);
        expect(result.observations[0].body).toEqual({
            accessToken: BODY_REDACTED,
            client: { name: "Dana" },
            client_secret: BODY_REDACTED,
            message: BODY_REDACTED,
        });
        expect(JSON.stringify(result)).not.toContain("live-access");
        expect(JSON.stringify(result)).not.toContain("RAW-BEARER-SECRET");
    });
});
