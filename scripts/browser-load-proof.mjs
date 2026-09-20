// Load the packaged extension in an isolated local Chrome and prove the parts a
// unit test cannot: Chrome's own manifest loader accepts the archive, the module
// service worker evaluates, the classic content script executes on a synthetic
// source origin, the popup page loads its module graph, and the source
// credential travels only over the internal message boundary.
//
// Usage:
//   node scripts/browser-load-proof.mjs --zip dist/<pkg>.zip --out <evidence.json>
//                                       [--chrome /path/to/chrome] [--negative-control]
//
// Isolation: a throwaway profile, all DNS mapped to NOTFOUND except the
// synthetic source host, which resolves to a local TLS server whose
// self-signed certificate is trusted only by SPKI pin for this process. No
// customer account, cookie, real source site or TGP API is contacted. This is a
// loader/boundary proof, not evidence that a customer import completes.
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
import { createServer } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractEntries, readZip, sha256 } from "./lib/shipping.mjs";

const SOURCE_HOST = "app.truecoach.co";
const SYNTHETIC_TOKEN = "synthetic.header.payload-not-a-real-credential";

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
/** @type {string | null} */
let lastPollError = null;

// ---- synthetic source origin --------------------------------------------------

function makeCertificate(dir) {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      `/CN=${SOURCE_HOST}`,
      "-addext",
      `subjectAltName=DNS:${SOURCE_HOST}`,
      "-days",
      "1",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const spkiDer = execFileSync("openssl", [
    "x509",
    "-in",
    cert,
    "-pubkey",
    "-noout",
  ]);
  const der = execFileSync("openssl", ["pkey", "-pubin", "-outform", "der"], {
    input: spkiDer,
  });
  const spki = execFileSync("openssl", ["dgst", "-sha256", "-binary"], {
    input: der,
  }).toString("base64");
  return { key: readFileSync(key), cert: readFileSync(cert), spki };
}

const PAGE_WITH_TOKEN = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>synthetic source</title></head>
<body><h1>Synthetic source page</h1>
<script>localStorage.setItem("auth", ${JSON.stringify(SYNTHETIC_TOKEN)});</script>
</body></html>`;
const PAGE_WITHOUT_TOKEN = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>synthetic empty</title></head>
<body><h1>Synthetic page without a session</h1><script>localStorage.clear();sessionStorage.clear();</script></body></html>`;

function startOrigin(tls) {
  /** @type {{ host: string | undefined, url: string | undefined }[]} */
  const requests = [];
  const server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    requests.push({ host: req.headers.host, url: req.url });
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(req.url === "/empty" ? PAGE_WITHOUT_TOKEN : PAGE_WITH_TOKEN);
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      ok({ server, port, requests });
    });
  });
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
  if (negativeControl) {
    // Reintroduce the historical main-branch defect so the proof demonstrably
    // detects a broken classic content script rather than passing vacuously.
    const target = join(extensionDir, "content", "main.js");
    writeFileSync(
      target,
      `${readFileSync(target, "utf8")}\nexport const readSourceBearer = () => "";\n`,
    );
  }
  const tls = makeCertificate(scratch);
  const origin = await startOrigin(tls);

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
      `--host-resolver-rules=MAP ${SOURCE_HOST} 127.0.0.1, MAP * ~NOTFOUND`,
      `--testing-fixed-https-port=${origin.port}`,
      `--ignore-certificate-errors-spki-list=${tls.spki}`,
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
  try {
    const version = await cdp.send("Browser.getVersion");
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    // Select OUR worker by the manifest's declared service worker path; Chrome
    // also runs component extensions with their own service workers.
    const shippedManifest = JSON.parse(
      readFileSync(join(extensionDir, "manifest.json"), "utf8"),
    );
    const workerPath = `/${shippedManifest.background.service_worker}`;
    const worker = await waitFor(
      () =>
        [...targets.values()].find(
          (target) =>
            target.type === "service_worker" &&
            target.url.startsWith("chrome-extension://") &&
            new URL(target.url).pathname === workerPath,
        ),
      20_000,
      `extension service worker target for ${workerPath}`,
    );
    const extensionId = new URL(worker.url).host;
    const workerSession = (
      await cdp.send("Target.attachToTarget", {
        targetId: worker.targetId,
        flatten: true,
      })
    ).sessionId;
    await cdp.send("Runtime.enable", {}, workerSession);
    progress.worker = { url: worker.url, targetId: worker.targetId };
    // Attaching on target discovery can precede the worker's extension
    // bindings and the module graph's top-level evaluation. Poll until the
    // runtime binding exists and the router has registered (or time out with
    // the last observed state so a failure here is diagnosable).
    const readiness = await waitForAsync(async () => {
      const state = await evaluate(
        cdp,
        workerSession,
        "JSON.stringify({ hasChrome: typeof chrome !== 'undefined', hasRuntime: typeof chrome !== 'undefined' && typeof chrome.runtime === 'object' && typeof chrome.runtime.id === 'string', listeners: typeof chrome !== 'undefined' && typeof chrome.runtime === 'object' && typeof chrome.runtime.onMessage === 'object' ? chrome.runtime.onMessage.hasListeners() : false })",
      ).then((value) => JSON.parse(value));
      progress.workerReadiness = state;
      return state.hasRuntime && state.listeners ? state : null;
    }, 15_000);
    check(
      "worker runtime bindings present and message router registered within 15s",
      readiness !== null,
      progress.workerReadiness,
    );
    const workerState = JSON.parse(
      await evaluate(
        cdp,
        workerSession,
        "JSON.stringify({ id: chrome.runtime.id, name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version, versionName: chrome.runtime.getManifest().version_name, worker: chrome.runtime.getManifest().background?.service_worker, listeners: chrome.runtime.onMessage.hasListeners() })",
      ),
    );
    check(
      "attached worker is the packaged extension (id, URL path and manifest identity agree)",
      workerState.id === extensionId &&
        new URL(worker.url).host === extensionId &&
        new URL(worker.url).pathname === workerPath &&
        workerState.worker === shippedManifest.background.service_worker &&
        workerState.name === shippedManifest.name &&
        workerState.version === shippedManifest.version &&
        workerState.versionName === shippedManifest.version_name,
      { workerUrl: worker.url, extensionId, workerState },
    );
    check(
      "worker registered its message router",
      workerState.listeners === true,
      workerState.listeners,
    );

    // Popup page: the module graph must load without exceptions.
    const popupTarget = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/popup/popup.html`,
    });
    const popupSession = (
      await cdp.send("Target.attachToTarget", {
        targetId: popupTarget.targetId,
        flatten: true,
      })
    ).sessionId;
    await cdp.send("Runtime.enable", {}, popupSession);
    await cdp.send("Page.enable", {}, popupSession);
    // Fresh profile => no paired session. The truthful popup behaviour is:
    // popup.js loads its module graph, asks the worker for session state, and
    // redirects to pair.html, whose module graph renders the pairing form.
    const pairUrl = `chrome-extension://${extensionId}/popup/pair.html`;
    const redirected = await waitFor(
      () => targets.get(popupTarget.targetId)?.url === pairUrl || null,
      10_000,
      "popup redirect to pair.html",
    ).catch(() => false);
    const popup = JSON.parse(
      await evaluate(
        cdp,
        popupSession,
        "new Promise((ok) => { const done = () => ok(JSON.stringify({ href: location.href, ready: document.readyState, pairForm: Boolean(document.getElementById('pair-form')), code: Boolean(document.getElementById('code')), start: Boolean(document.getElementById('start-import')) })); if (document.readyState === 'complete') done(); else window.addEventListener('load', done); })",
        true,
      ),
    );
    check(
      "popup loaded, learned there is no session, and redirected to the pairing view",
      redirected === true &&
        popup.href === pairUrl &&
        popup.ready === "complete" &&
        popup.pairForm === true &&
        popup.code === true &&
        popup.start === false,
      { redirected, popup },
    );

    // Synthetic source tab: content script must execute in an isolated world.
    /** @type {Set<string>} */
    const isolatedOrigins = new Set();
    const pageTarget = await cdp.send("Target.createTarget", {
      url: "about:blank",
    });
    const pageSession = (
      await cdp.send("Target.attachToTarget", {
        targetId: pageTarget.targetId,
        flatten: true,
      })
    ).sessionId;
    cdp.on((event) => {
      if (
        event.sessionId === pageSession &&
        event.method === "Runtime.executionContextCreated" &&
        event.params.context.auxData?.type === "isolated"
      ) {
        isolatedOrigins.add(event.params.context.origin);
      }
    });
    await cdp.send("Runtime.enable", {}, pageSession);
    await cdp.send("Page.enable", {}, pageSession);
    await cdp.send("Network.enable", {}, pageSession);
    await cdp.send("Network.enable", {}, workerSession);
    await cdp.send("Network.enable", {}, popupSession);
    await cdp.send(
      "Page.navigate",
      { url: `https://${SOURCE_HOST}/clients` },
      pageSession,
    );
    await waitFor(
      () => origin.requests.some((request) => request.url === "/clients"),
      10_000,
      "synthetic origin request",
    );
    const contentWorld = await waitFor(
      () => isolatedOrigins.has(`chrome-extension://${extensionId}`) || null,
      10_000,
      "content script isolated world",
    ).catch((error) => error);
    check(
      "content script isolated world created on the synthetic source origin",
      contentWorld === true,
      [...isolatedOrigins],
    );

    // Boundary: the worker asks the tab for the source credential; the reply
    // must carry exactly the synthetic token, and nothing else may see it.
    const collect = async (expected) => {
      return JSON.parse(
        await evaluate(
          cdp,
          workerSession,
          `(async () => {
            const tabs = await chrome.tabs.query({ url: "https://${SOURCE_HOST}/*" });
            if (tabs.length !== 1) return JSON.stringify({ tabs: tabs.length });
            const deadline = Date.now() + 8000;
            let last = null;
            while (Date.now() < deadline) {
              try {
                last = await chrome.tabs.sendMessage(tabs[0].id, { kind: "collect_source_token" });
                if (last && last.ok === ${expected}) break;
              } catch (error) {
                last = { thrown: error instanceof Error ? error.message : String(error) };
              }
              await new Promise((r) => setTimeout(r, 200));
            }
            return JSON.stringify({ tabs: 1, reply: last });
          })()`,
          true,
        ),
      );
    };
    const withToken = await collect(true);
    check(
      "worker collects the synthetic source token over the internal message boundary",
      withToken.reply?.ok === true &&
        withToken.reply?.token === SYNTHETIC_TOKEN,
      {
        tabs: withToken.tabs,
        ok: withToken.reply?.ok,
        tokenMatches: withToken.reply?.token === SYNTHETIC_TOKEN,
        thrown: withToken.reply?.thrown,
      },
    );
    await cdp.send(
      "Page.navigate",
      { url: `https://${SOURCE_HOST}/empty` },
      pageSession,
    );
    await waitFor(
      () => origin.requests.some((request) => request.url === "/empty"),
      10_000,
      "synthetic empty page request",
    );
    const withoutToken = await collect(false);
    check(
      "worker receives an honest { ok: false } when the page holds no session",
      withoutToken.reply?.ok === false &&
        !("token" in (withoutToken.reply ?? {})),
      { ok: withoutToken.reply?.ok, thrown: withoutToken.reply?.thrown },
    );

    const persisted = JSON.parse(
      await evaluate(
        cdp,
        workerSession,
        `(async () => {
          const out = { storageType: typeof chrome.storage, apis: Object.keys(chrome).sort() };
          if (chrome.storage) {
            out.local = await chrome.storage.local.get(null);
            out.session = await chrome.storage.session.get(null);
          }
          return JSON.stringify(out);
        })()`,
        true,
      ),
    );
    const persistedText = JSON.stringify([persisted.local, persisted.session]);
    check(
      "chrome.storage is bound in the worker (storage permission honoured)",
      persisted.storageType === "object",
      { storageType: persisted.storageType, apis: persisted.apis },
    );
    check(
      "synthetic token never reaches extension storage or console output",
      !persistedText.includes(SYNTHETIC_TOKEN) &&
        !consoleLines.some((line) => line.includes(SYNTHETIC_TOKEN)) &&
        !exceptions.some((entry) => entry.text.includes(SYNTHETIC_TOKEN)),
      { storageKeys: Object.keys(persisted.local ?? {}) },
    );
    check(
      "no runtime exceptions in worker, popup or content script",
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
      "every network request observed on page, popup and worker sessions targeted the synthetic host or the extension origin (all other hosts resolve NOTFOUND by resolver rule)",
      attemptedHosts.length > 0 &&
        attemptedHosts.every(
          (host) => host === SOURCE_HOST || host === "chrome-extension:",
        ) &&
        origin.requests.every((request) => request.host === SOURCE_HOST),
      { attemptedHosts, served: origin.requests },
    );

    evidence = {
      kind: negativeControl
        ? "browser-load-proof:negative-control"
        : "browser-load-proof",
      generatedAt: new Date().toISOString(),
      chrome: { path: chrome, ...version },
      package: {
        path: zipPath,
        sha256: zipSha256,
        bytes: zip.length,
        inventory: readInventory(zipPath),
      },
      mutation: negativeControl
        ? {
            file: "content/main.js",
            appended: 'export const readSourceBearer = () => "";',
            sha256AfterMutation: sha256(
              readFileSync(join(extensionDir, "content", "main.js")),
            ),
          }
        : null,
      extensionId,
      isolation: {
        hostResolverRules: `MAP ${SOURCE_HOST} 127.0.0.1, MAP * ~NOTFOUND`,
        syntheticOriginPort: origin.port,
        profile: "throwaway",
      },
      checks,
      consoleLines,
      exceptions,
    };
  } catch (error) {
    abortError = error instanceof Error ? error.stack : String(error);
  } finally {
    child.kill("SIGKILL");
    origin.server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!evidence) {
    evidence = {
      kind: "browser-load-proof:aborted",
      package: { sha256: zipSha256 },
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
    // The control must fail in the SPECIFIC way a classic script with module
    // syntax fails in Chrome: the content script never registers its listener,
    // so the worker's collect gets no receiver. Unrelated failures (worker,
    // popup, storage, network) must still pass, or the control is not a control.
    const byName = new Map(checks.map((entry) => [entry.name, entry]));
    const collect = byName.get(
      "worker collects the synthetic source token over the internal message boundary",
    );
    const collectDetail =
      /** @type {{ tabs?: number, thrown?: string, ok?: boolean }} */ (
        collect?.detail ?? {}
      );
    const noReceiver =
      collect?.pass === false &&
      collectDetail.tabs === 1 &&
      typeof collectDetail.thrown === "string" &&
      /Receiving end does not exist|Could not establish connection/.test(
        collectDetail.thrown,
      );
    const syntaxSeen = exceptions.some((entry) =>
      /Unexpected token 'export'|Cannot use import statement|export/.test(
        entry.text,
      ),
    );
    const unrelatedFailures = failed.filter(
      (entry) =>
        !/collects the synthetic source token|honest \{ ok: false \}|no runtime exceptions|content script isolated world/.test(
          entry.name,
        ),
    );
    const detected = noReceiver && unrelatedFailures.length === 0;
    evidence.negativeControl = {
      detected,
      noReceiver,
      syntaxExceptionSeen: syntaxSeen,
      unrelatedFailures: unrelatedFailures.map((entry) => entry.name),
    };
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(
      `negative control: ${detected ? "DETECTED" : "NOT DETECTED"} — noReceiver=${noReceiver} syntaxExceptionSeen=${syntaxSeen} unrelatedFailures=${unrelatedFailures.length}\n`,
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
