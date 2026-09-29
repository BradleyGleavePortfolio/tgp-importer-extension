// Load the PACKAGED extension in an isolated Chromium and prove the parts a
// unit test cannot, for the Start-grant (X1 r3/r4) flow:
//   - Chrome's own manifest loader accepts the archive and the module service
//     worker evaluates with no exception; its message router and the
//     permissions/tab lifecycle listeners are registered;
//   - the shipped manifest holds exactly the frozen permission set (no
//     activeTab), exactly the TGP backend host, https-only optional hosts and
//     NO static content script;
//   - the configured backend origin (shared/protocol.js TGP_API_ORIGIN) is the
//     manifest's one required host;
//   - a fresh worker holds no optional host grant (startup sweep verified);
//   - the popup renders as STATUS with exactly one Start button (owner D9),
//     routes to pairing with no session, and with a session shows the ready
//     status; a real click on Start (CDP input, a genuine user gesture) on a
//     non-https active page yields the approved no-run copy and prompts for
//     nothing.
//
// Usage:
//   node scripts/browser-load-proof.mjs --zip dist/<pkg>.zip --out <evidence.json>
//                                       [--chrome /path/to/chrome] [--negative-control]
//
// Isolation: a throwaway profile; every host resolves NOTFOUND, so no customer
// account, cookie, source site or TGP API is contacted. Nothing here prompts
// Chrome for a host grant (that needs the real action popup and a coach), so
// this is a loader/boundary proof, not evidence that a customer import runs.
//
// The runtime is whatever `--chrome` / TGP_CHROME / the Playwright cache
// provides; the evidence records Browser.getVersion verbatim. Playwright
// Chromium is NOT branded Google Chrome and is labelled as such.
//
// Exit codes: 0 all checks passed; 1 a check failed; 2 runtime unavailable.
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractEntries, readZip, sha256 } from "./lib/shipping.mjs";

const EXPECTED_BACKEND_ORIGIN = "https://backend-spring-lake-3890.fly.dev";
const EXPECTED_PERMISSIONS = [
  "debugger",
  "notifications",
  "scripting",
  "storage",
  "tabs",
];
const EXPECTED_OPTIONAL_HOSTS = ["https://*/*"];
const SYNTHETIC_REFRESH = "proof-synthetic-refresh-token-not-a-credential";

function argument(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

function locateChrome() {
  const explicit = process.env.TGP_CHROME ?? argument("--chrome", "");
  if (explicit) return existsSync(explicit) ? explicit : null;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return null;
  const candidates = execFileSync("find", [
    cache,
    "-maxdepth",
    "3",
    "-type",
    "f",
    "-name",
    "chrome",
    "-path",
    "*chromium-*/chrome-linux*/chrome",
  ])
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .sort();
  return candidates.at(-1) ?? null;
}

// The packager writes `<zip>.inventory.json` beside the archive with the source
// head and per-file hashes; carry its identity block into the evidence so the
// proof is bound to the exact candidate, not just to bytes.
function readInventory(zipPath) {
  const path = zipPath.replace(/\.zip$/, ".inventory.json");
  if (!existsSync(path)) return null;
  const inventory = JSON.parse(readFileSync(path, "utf8"));
  return {
    path,
    source: inventory.source ?? null,
    zipSha256: inventory.zip?.sha256 ?? null,
    files: Array.isArray(inventory.files) ? inventory.files.length : null,
  };
}

// ---- CDP over --remote-debugging-pipe (fd 3 in, fd 4 out) --------------------

function connectPipe(child) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  let buffer = Buffer.alloc(0);
  const output = child.stdio[4];
  if (!output || !child.stdio[3]) throw new Error("pipe fds missing");
  output.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let end = buffer.indexOf(0);
    while (end >= 0) {
      const message = JSON.parse(buffer.toString("utf8", 0, end));
      buffer = buffer.subarray(end + 1);
      if (message.id && pending.has(message.id)) {
        const { resolve: ok, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else ok(message.result);
      } else if (message.method) {
        for (const listener of listeners) listener(message);
      }
      end = buffer.indexOf(0);
    }
  });
  const input = /** @type {import("node:stream").Writable} */ (child.stdio[3]);
  return {
    send(method, params = {}, sessionId = undefined) {
      const id = nextId;
      nextId += 1;
      const payload = {
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      };
      input.write(`${JSON.stringify(payload)}\0`);
      return new Promise((ok, reject) => {
        pending.set(id, { resolve: ok, reject });
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
        }, 15_000);
      });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  return new Promise((ok, reject) => {
    const tick = () => {
      const value = predicate();
      if (value) ok(value);
      else if (Date.now() - started > timeoutMs)
        reject(new Error(`timeout waiting for ${label}`));
      else setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * Evaluate `expression` in a session and return its JSON-serialisable value,
 * surfacing thrown exceptions and undefined results instead of hiding them.
 * @param {{ send: (method: string, params?: object, sessionId?: string) => Promise<any> }} cdp
 */
async function evaluate(cdp, sessionId, expression, awaitPromise = false) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(
      `evaluate failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`,
    );
  }
  if (result.result?.value === undefined) {
    throw new Error(
      `evaluate returned no value: ${JSON.stringify(result).slice(0, 400)}`,
    );
  }
  return result.result.value;
}

/** @type {string | null} */
let lastPollError = null;

/**
 * Poll an async predicate every 250 ms until it returns a truthy value or
 * `timeoutMs` elapses; returns null on timeout (never throws) so the caller
 * can record the last observed state.
 * @template T
 * @param {() => Promise<T | null>} predicate
 * @param {number} timeoutMs
 * @returns {Promise<T | null>}
 */
async function waitForAsync(predicate, timeoutMs) {
  const started = Date.now();
  for (;;) {
    let value = null;
    try {
      value = await predicate();
    } catch (error) {
      value = null;
      lastPollError = error instanceof Error ? error.message : String(error);
    }
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((ok) => setTimeout(ok, 250));
  }
}

// Chrome derives an unpacked extension's id from its directory path: the first
// 32 hex digits of sha256(path), each mapped onto a..p. Computing it lets the
// proof address the extension's pages even when its worker never came up.
function unpackedExtensionId(directory) {
  return [...sha256(Buffer.from(directory, "utf8")).slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");
}

function sameSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    [...actual].sort().join("\n") === [...expected].sort().join("\n")
  );
}

// A REAL click (trusted input event through CDP) on the centre of an element,
// so Chrome sees a user gesture, exactly as the coach's click would.
async function clickElement(cdp, sessionId, selector) {
  const box = JSON.parse(
    await evaluate(
      cdp,
      sessionId,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify(null); el.scrollIntoView(); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: el.disabled === true }); })()`,
    ),
  );
  if (box === null) throw new Error(`no element ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send(
      "Input.dispatchMouseEvent",
      {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
        ...(type === "mouseMoved" ? {} : { buttons: 1 }),
      },
      sessionId,
    );
  }
  return box;
}

// ---- proof ----------------------------------------------------------------------

async function main() {
  const zipPath = resolve(argument("--zip", ""));
  const outPath = resolve(argument("--out", "browser-load-proof.json"));
  const negativeControl = process.argv.includes("--negative-control");
  if (!zipPath || !existsSync(zipPath)) {
    process.stderr.write("usage: --zip <package.zip> --out <evidence.json>\n");
    process.exit(2);
  }
  const chrome = locateChrome();
  if (!chrome) {
    process.stderr.write(
      "GAP: no Chrome binary (set TGP_CHROME or --chrome); browser proof not run\n",
    );
    process.exit(2);
  }
  const zip = readFileSync(zipPath);
  const zipSha256 = sha256(zip);
  const scratch = mkdtempSync(join(tmpdir(), "tgp-browser-proof-"));
  const extensionDir = join(scratch, "extension");
  mkdirSync(extensionDir);
  extractEntries(readZip(zip), extensionDir, { mkdirSync, writeFileSync });
  /** @type {null | { file: string, appended: string, sha256AfterMutation: string }} */
  let mutation = null;
  if (negativeControl) {
    // Break the packaged worker's module graph the way a bad package would:
    // a static import of a file that is not in the archive. Chrome must
    // refuse to evaluate the worker, and the proof must SEE that (router
    // never registered) rather than pass vacuously.
    const target = join(extensionDir, "background.js");
    const appended = 'import "./shared/not-shipped-by-anyone.js";\n';
    writeFileSync(target, `${readFileSync(target, "utf8")}\n${appended}`);
    mutation = {
      file: "background.js",
      appended,
      sha256AfterMutation: sha256(readFileSync(target)),
    };
  }
  const shippedManifest = JSON.parse(
    readFileSync(join(extensionDir, "manifest.json"), "utf8"),
  );

  /** @type {{ name: string, pass: boolean, detail: unknown }[]} */
  const checks = [];
  const check = (name, pass, detail) => {
    checks.push({ name, pass, detail });
  };
  /** @type {string[]} */
  const consoleLines = [];
  /** @type {{ target: string, text: string }[]} */
  const exceptions = [];
  /** @type {string[]} */
  const attemptedUrls = [];
  /** @type {Record<string, unknown>} */
  const progress = {};

  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${join(scratch, "profile")}`,
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-gpu",
      "--no-sandbox",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  /** @type {string[]} */
  const stderrLines = [];
  child.stdio[2]?.on("data", (chunk) => {
    stderrLines.push(chunk.toString("utf8"));
  });
  const cdp = connectPipe(child);
  /** @type {Map<string, { targetId: string, type: string, url: string }>} */
  const targets = new Map();
  cdp.on((event) => {
    if (event.method === "Target.targetCreated") {
      targets.set(event.params.targetInfo.targetId, event.params.targetInfo);
    } else if (event.method === "Target.targetInfoChanged") {
      targets.set(event.params.targetInfo.targetId, event.params.targetInfo);
    } else if (event.method === "Runtime.exceptionThrown") {
      const details = event.params.exceptionDetails;
      exceptions.push({
        target: event.sessionId ?? "browser",
        text: `${details.text} ${details.exception?.description ?? ""} @${details.url ?? ""}:${details.lineNumber}`,
      });
    } else if (event.method === "Network.requestWillBeSent") {
      attemptedUrls.push(String(event.params.request?.url ?? ""));
    } else if (event.method === "Runtime.consoleAPICalled") {
      consoleLines.push(
        event.params.args
          .map((arg) => String(arg.value ?? arg.description ?? ""))
          .join(" "),
      );
    }
  });

  /** @type {Record<string, unknown> | undefined} */
  let evidence;
  /** @type {string | undefined} */
  let abortError;
  /** @type {Record<string, unknown>} */
  let version = {};
  try {
    version = await cdp.send("Browser.getVersion");
    await cdp.send("Target.setDiscoverTargets", { discover: true });

    // ---- 1. shipped manifest surface (bytes Chrome was handed) -------------
    check(
      "shipped manifest: exact permission set (no activeTab), exact TGP host, https-only optional hosts, no static content script",
      sameSet(shippedManifest.permissions, EXPECTED_PERMISSIONS) &&
        sameSet(shippedManifest.host_permissions, [
          `${EXPECTED_BACKEND_ORIGIN}/*`,
        ]) &&
        sameSet(
          shippedManifest.optional_host_permissions,
          EXPECTED_OPTIONAL_HOSTS,
        ) &&
        shippedManifest.content_scripts === undefined &&
        shippedManifest.optional_permissions === undefined &&
        shippedManifest.background?.type === "module",
      {
        permissions: shippedManifest.permissions,
        host_permissions: shippedManifest.host_permissions,
        optional_host_permissions: shippedManifest.optional_host_permissions,
        content_scripts: shippedManifest.content_scripts ?? null,
      },
    );

    // ---- 2. worker target appears and evaluates ---------------------------
    const workerPath = `/${shippedManifest.background.service_worker}`;
    const extensionId = unpackedExtensionId(extensionDir);
    const workerUrl = `chrome-extension://${extensionId}${workerPath}`;
    // A worker Chrome refuses to evaluate may surface as a target for a moment
    // and vanish before it can be attached, or never surface at all; either
    // way it is "not ready", recorded as such rather than aborting the proof.
    let workerSession = "";
    /** @type {{ targetId: string, url: string } | null} */
    let worker = null;
    try {
      worker = await waitFor(
        () =>
          [...targets.values()].find(
            (target) =>
              target.type === "service_worker" && target.url === workerUrl,
          ),
        20_000,
        `extension service worker target ${workerUrl}`,
      );
      workerSession = (
        await cdp.send("Target.attachToTarget", {
          targetId: worker.targetId,
          flatten: true,
        })
      ).sessionId;
      await cdp.send("Runtime.enable", {}, workerSession);
      await cdp.send("Network.enable", {}, workerSession);
    } catch (error) {
      progress.workerAttach =
        error instanceof Error ? error.message : String(error);
      workerSession = "";
    }
    progress.worker = worker
      ? { url: worker.url, targetId: worker.targetId }
      : null;
    const readiness =
      workerSession === ""
        ? null
        : await waitForAsync(async () => {
            const state = await evaluate(
              cdp,
              workerSession,
              `JSON.stringify((() => {
          const has = (ev) => typeof ev === "object" && ev !== null && ev.hasListeners();
          const rt = typeof chrome !== "undefined" && typeof chrome.runtime === "object";
          return {
            hasChrome: typeof chrome !== "undefined",
            hasRuntime: rt && typeof chrome.runtime.id === "string",
            onMessage: rt && has(chrome.runtime.onMessage),
            permissionsOnAdded: rt && typeof chrome.permissions === "object" && has(chrome.permissions.onAdded),
            permissionsOnRemoved: rt && typeof chrome.permissions === "object" && has(chrome.permissions.onRemoved),
            tabsOnRemoved: rt && typeof chrome.tabs === "object" && has(chrome.tabs.onRemoved),
            tabsOnUpdated: rt && typeof chrome.tabs === "object" && has(chrome.tabs.onUpdated),
          };
        })())`,
            ).then((value) => JSON.parse(value));
            progress.workerReadiness = state;
            return state.hasRuntime && state.onMessage ? state : null;
          }, 15_000);
    check(
      "worker evaluated: runtime bindings present and the message router registered within 15 s",
      readiness !== null,
      {
        worker: progress.worker,
        attach: progress.workerAttach ?? null,
        readiness: progress.workerReadiness ?? null,
        lastPollError,
      },
    );
    check(
      "worker registered the Start-grant lifecycle listeners (permissions.onAdded/onRemoved, tabs.onRemoved/onUpdated)",
      readiness !== null &&
        readiness.permissionsOnAdded === true &&
        readiness.permissionsOnRemoved === true &&
        readiness.tabsOnRemoved === true &&
        readiness.tabsOnUpdated === true,
      progress.workerReadiness,
    );
    const workerExceptions = exceptions.filter(
      (entry) => entry.target === workerSession,
    );
    check(
      "no exception thrown while the worker's module graph evaluated",
      readiness !== null && workerExceptions.length === 0,
      workerExceptions,
    );

    if (readiness !== null) {
      const workerState = JSON.parse(
        await evaluate(
          cdp,
          workerSession,
          `(async () => {
            const m = chrome.runtime.getManifest();
            const all = await chrome.permissions.getAll();
            return JSON.stringify({
              id: chrome.runtime.id,
              name: m.name, version: m.version, versionName: m.version_name,
              worker: m.background && m.background.service_worker,
              permissions: m.permissions, hostPermissions: m.host_permissions,
              optionalHostPermissions: m.optional_host_permissions,
              contentScripts: m.content_scripts ?? null,
              heldOrigins: all.origins ?? [], heldPermissions: all.permissions ?? [],
            });
          })()`,
          true,
        ),
      );
      check(
        "attached worker is the packaged extension (id derived from the unpacked path, URL path and manifest identity agree)",
        workerState.id === extensionId &&
          worker !== null &&
          worker.url === workerUrl &&
          workerState.worker === shippedManifest.background.service_worker &&
          workerState.name === shippedManifest.name &&
          workerState.version === shippedManifest.version &&
          workerState.versionName === shippedManifest.version_name,
        { workerUrl, extensionId, workerState },
      );
      check(
        "Chrome installed exactly the frozen permission set: no activeTab, required host is the TGP backend only",
        sameSet(workerState.permissions, EXPECTED_PERMISSIONS) &&
          sameSet(workerState.hostPermissions, [
            `${EXPECTED_BACKEND_ORIGIN}/*`,
          ]) &&
          sameSet(
            workerState.optionalHostPermissions,
            EXPECTED_OPTIONAL_HOSTS,
          ) &&
          workerState.contentScripts === null,
        {
          permissions: workerState.permissions,
          hostPermissions: workerState.hostPermissions,
          optionalHostPermissions: workerState.optionalHostPermissions,
        },
      );
      // Startup sweep: a fresh worker holds no optional host grant; the only
      // origin Chrome reports held is the required backend host.
      check(
        "fresh worker holds no optional host grant (permissions.getAll origins = required TGP host only)",
        sameSet(workerState.heldOrigins, [`${EXPECTED_BACKEND_ORIGIN}/*`]) &&
          !workerState.heldPermissions.includes("activeTab"),
        {
          heldOrigins: workerState.heldOrigins,
          heldPermissions: workerState.heldPermissions,
        },
      );
    }

    // ---- 3. popup with NO session: routes to pairing ------------------------
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
    const pairUrl = `chrome-extension://${extensionId}/popup/pair.html`;
    const openPage = async (url) => {
      const target = await cdp.send("Target.createTarget", { url });
      const sessionId = (
        await cdp.send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        })
      ).sessionId;
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Network.enable", {}, sessionId);
      return { targetId: target.targetId, sessionId };
    };
    const popup1 = await openPage(popupUrl);
    const redirected = await waitFor(
      () => targets.get(popup1.targetId)?.url === pairUrl || null,
      10_000,
      "popup redirect to pair.html",
    ).catch(() => false);
    const pairing = JSON.parse(
      await evaluate(
        cdp,
        popup1.sessionId,
        "new Promise((ok) => { const done = () => ok(JSON.stringify({ href: location.href, ready: document.readyState, pairForm: Boolean(document.getElementById('pair-form')), start: document.querySelectorAll('#start-import').length })); if (document.readyState === 'complete') done(); else window.addEventListener('load', done); })",
        true,
      ),
    );
    check(
      "popup with no session: module graph loads, learns there is no session, routes to the pairing view (no Start there)",
      redirected === true &&
        pairing.href === pairUrl &&
        pairing.ready === "complete" &&
        pairing.pairForm === true &&
        pairing.start === 0,
      { redirected, pairing },
    );
    await cdp.send("Target.closeTarget", { targetId: popup1.targetId });

    // ---- 4. the configured backend origin, read from the shipped module ----
    // (a page context may import() the shipped module; a worker may not.)
    const probe = await openPage(
      `chrome-extension://${extensionId}/popup/pair.html`,
    );
    const backend = JSON.parse(
      await evaluate(
        cdp,
        probe.sessionId,
        `import(${JSON.stringify(`chrome-extension://${extensionId}/shared/protocol.js`)}).then((m) => JSON.stringify({ origin: m.TGP_API_ORIGIN, isTgp: m.isTgpOrigin(m.TGP_API_ORIGIN), siblingIsTgp: m.isTgpOrigin("https://someone-else.fly.dev") }))`,
        true,
      ),
    );
    check(
      `configured backend origin is exactly ${EXPECTED_BACKEND_ORIGIN} (shared/protocol.js TGP_API_ORIGIN in the shipped bytes) and equals the manifest's one required host`,
      backend.origin === EXPECTED_BACKEND_ORIGIN &&
        backend.isTgp === true &&
        backend.siblingIsTgp === false &&
        sameSet(shippedManifest.host_permissions, [`${backend.origin}/*`]),
      backend,
    );
    await cdp.send("Target.closeTarget", { targetId: probe.targetId });

    // ---- 5. popup WITH a session: status view, exactly one Start ------------
    // A synthetic refresh token in chrome.storage.session is what a paired
    // extension holds; it is never presented (no network leaves this process:
    // every host resolves NOTFOUND) and it is a nonsense string.
    if (readiness !== null) {
      await evaluate(
        cdp,
        workerSession,
        `chrome.storage.session.set({ tgp_refresh_token: ${JSON.stringify(SYNTHETIC_REFRESH)} }).then(() => "ok")`,
        true,
      );
    }
    const popup2 = await openPage(popupUrl);
    const rendered = await waitForAsync(async () => {
      const state = JSON.parse(
        await evaluate(
          cdp,
          popup2.sessionId,
          `JSON.stringify((() => {
            const buttons = [...document.querySelectorAll('button')].map((b) => ({ id: b.id, text: (b.textContent || '').trim(), i18n: b.getAttribute('data-i18n'), disabled: b.disabled, hidden: b.hidden || b.closest('[hidden]') !== null }));
            const start = document.querySelectorAll('#start-import');
            const empty = document.getElementById('empty');
            const error = document.getElementById('error');
            return {
              href: location.href, ready: document.readyState,
              startButtons: start.length,
              startText: start[0] ? (start[0].textContent || '').trim() : null,
              startDisabled: start[0] ? start[0].disabled : null,
              startLocked: start[0] ? start[0].dataset.outcomeLocked : null,
              buttons,
              statusText: empty ? (empty.textContent || '').trim() : null,
              errorHidden: error ? error.hidden : null,
              errorText: error ? (error.textContent || '').trim() : null,
            };
          })())`,
        ),
      );
      progress.popup = state;
      // The worker's status reply has landed once Start is unlocked.
      return state.ready === "complete" && state.startLocked === "false"
        ? state
        : null;
    }, 10_000);
    const popupState = rendered ?? progress.popup;
    const statusButtons = Array.isArray(popupState?.buttons)
      ? popupState.buttons.filter((b) => b.id !== "start-import")
      : [];
    check(
      "popup with a session renders as status with EXACTLY ONE Start button (owner D9); every other button is a status action",
      rendered !== null &&
        popupState.href === popupUrl &&
        popupState.startButtons === 1 &&
        popupState.startText === "Start Import" &&
        statusButtons.length === (popupState.buttons?.length ?? 0) - 1 &&
        statusButtons.every(
          (b) => typeof b.i18n === "string" && b.i18n.startsWith("outcome_"),
        ),
      popupState,
    );
    check(
      "popup shows the worker's status (no recorded transfer) and Start is enabled, with no error shown",
      rendered !== null &&
        popupState.startDisabled === false &&
        popupState.errorHidden === true &&
        typeof popupState.statusText === "string" &&
        popupState.statusText.startsWith("No recorded transfer"),
      popupState,
    );

    // ---- 6. a REAL click on Start with a non-https active page -------------
    // The popup opened as a tab is itself the active tab of its window, and a
    // chrome-extension:// page is not https: the approved no-run copy must
    // appear, nothing may be registered or prompted, no exception.
    let clicked = null;
    if (rendered !== null) {
      const exceptionsBefore = exceptions.length;
      const requestsBefore = attemptedUrls.length;
      await clickElement(cdp, popup2.sessionId, "#start-import");
      clicked = await waitForAsync(async () => {
        const state = JSON.parse(
          await evaluate(
            cdp,
            popup2.sessionId,
            "JSON.stringify({ errorHidden: document.getElementById('error').hidden, errorText: (document.getElementById('error').textContent || '').trim(), startDisabled: document.getElementById('start-import').disabled })",
          ),
        );
        progress.afterClick = state;
        return state.errorHidden === false && state.errorText.length > 0
          ? state
          : null;
      }, 5_000);
      const newRequests = attemptedUrls
        .slice(requestsBefore)
        .filter((url) => !url.startsWith("chrome-extension://"));
      check(
        "a real click on Start from a non-https active page shows the approved no-run copy, starts nothing, prompts for nothing, makes no network request",
        clicked !== null &&
          clicked.errorText.startsWith(
            "This page isn't a safe place to start an import from",
          ) &&
          clicked.startDisabled === false &&
          exceptions.length === exceptionsBefore &&
          newRequests.length === 0,
        { afterClick: progress.afterClick, newRequests },
      );
    }

    // ---- 7. boundaries -----------------------------------------------------
    const persisted =
      readiness === null
        ? null
        : JSON.parse(
            await evaluate(
              cdp,
              workerSession,
              `(async () => JSON.stringify({ local: await chrome.storage.local.get(null), sessionKeys: Object.keys(await chrome.storage.session.get(null)) }))()`,
              true,
            ),
          );
    check(
      "the synthetic session secret never reaches disk storage, console output or an exception text",
      persisted !== null &&
        !JSON.stringify(persisted.local).includes(SYNTHETIC_REFRESH) &&
        !consoleLines.some((line) => line.includes(SYNTHETIC_REFRESH)) &&
        !exceptions.some((entry) => entry.text.includes(SYNTHETIC_REFRESH)),
      persisted === null
        ? null
        : {
            localKeys: Object.keys(persisted.local),
            sessionKeys: persisted.sessionKeys,
          },
    );
    check(
      "no runtime exception in the worker or any extension page for the whole session",
      exceptions.length === 0,
      exceptions,
    );
    const attemptedHosts = [
      ...new Set(
        attemptedUrls.map((url) => {
          try {
            const parsed = new URL(url);
            return parsed.protocol === "chrome-extension:"
              ? parsed.protocol
              : parsed.host;
          } catch {
            return url;
          }
        }),
      ),
    ].sort();
    check(
      "every network request observed on worker and popup sessions targeted the extension origin only (all hosts resolve NOTFOUND by resolver rule)",
      attemptedHosts.length > 0 &&
        attemptedHosts.every((host) => host === "chrome-extension:"),
      { attemptedHosts },
    );

    evidence = {
      kind: negativeControl
        ? "browser-load-proof:negative-control"
        : "browser-load-proof",
      flow: "x1-r4 Start-grant (register-first) flow",
      generatedAt: new Date().toISOString(),
      runtime: {
        path: chrome,
        label:
          typeof version.product === "string" &&
          /^Chrome\//.test(version.product) &&
          /ms-playwright|chromium/.test(chrome)
            ? "Playwright Chromium (not branded Google Chrome)"
            : "as reported by Browser.getVersion",
        headless: "--headless=new",
        ...version,
      },
      package: {
        path: zipPath,
        sha256: zipSha256,
        bytes: zip.length,
        inventory: readInventory(zipPath),
      },
      mutation,
      extensionId,
      isolation: {
        hostResolverRules: "MAP * ~NOTFOUND",
        profile: "throwaway",
        syntheticSession:
          "chrome.storage.session refresh token, nonsense string, never presented",
      },
      notObserved: [
        "Chrome's host-permission prompt and the popup closing on it (needs the real action popup and a coach gesture)",
        "permissions.onAdded delivery order versus runtime.onMessage on a cold worker",
        "worker idle termination during a >30 s prompt",
        "scripting.executeScript into a live https source tab and its documentId",
        "a backend terminal-state race",
      ],
      checks,
      consoleLines,
      exceptions,
    };
  } catch (error) {
    abortError = error instanceof Error ? error.stack : String(error);
  } finally {
    child.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!evidence) {
    evidence = {
      kind: "browser-load-proof:aborted",
      runtime: { path: chrome, ...version },
      package: { sha256: zipSha256 },
      mutation,
      checks,
      exceptions,
      abortError,
      progress,
      lastPollError,
      stderr: stderrLines.filter((line) => !line.includes("dbus")).slice(-20),
    };
  }
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  const failed = checks.filter((entry) => !entry.pass);
  if (abortError) {
    process.stderr.write(`browser load proof aborted: ${abortError}\n`);
    failed.push({ name: "aborted", pass: false, detail: abortError });
  }
  for (const entry of checks) {
    process.stdout.write(`${entry.pass ? "PASS" : "FAIL"} ${entry.name}\n`);
  }
  process.stdout.write(
    `package sha256 ${zipSha256}; evidence ${outPath}; ${failed.length} failed\n`,
  );
  if (negativeControl) {
    // The control must fail in the SPECIFIC way a broken packaged worker
    // fails: Chrome does not evaluate the module graph, so the router is
    // never registered and the popup cannot reach the worker. The static
    // manifest check (bytes only) must still pass, or this is not a control.
    const byName = new Map(checks.map((entry) => [entry.name, entry]));
    const readinessCheck = [...byName.values()].find((entry) =>
      entry.name.startsWith("worker evaluated:"),
    );
    const manifestCheck = [...byName.values()].find((entry) =>
      entry.name.startsWith("shipped manifest:"),
    );
    const workerNotReady = readinessCheck?.pass === false;
    const manifestStillGood = manifestCheck?.pass === true;
    const detected = workerNotReady && manifestStillGood;
    evidence.negativeControl = {
      detected,
      workerNotReady,
      manifestStillGood,
      failedChecks: failed.map((entry) => entry.name),
      stderrTail: stderrLines
        .filter((line) => !line.includes("dbus"))
        .slice(-10),
    };
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(
      `negative control: ${detected ? "DETECTED" : "NOT DETECTED"} — workerNotReady=${workerNotReady} manifestStillGood=${manifestStillGood}\n`,
    );
    process.exit(detected ? 0 : 1);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(
    `browser load proof aborted: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
