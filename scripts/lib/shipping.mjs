// Shipping-bytes model for the packaged extension.
//
// The package is defined by what the manifest actually loads, not by a
// directory allowlist: manifest.json, the service-worker module graph, every
// classic content script, extension pages and their module graphs, icons and
// locales. Anything the manifest cannot reach is development-only and never
// ships; anything the manifest reaches outside the shipping tree, or that fails
// to parse the way Chrome will parse it, fails the build closed.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { Script } from "node:vm";
import { constantString, parseSource, ts, visit } from "./js-ast.mjs";

// Development-only trees. Reaching one of these from the manifest is a defect.
export const DEVELOPMENT_ONLY = [
  ".git",
  ".github",
  "docs",
  "node_modules",
  "scripts",
  "test",
  "types",
  "dist",
];

// Files whose extension is required for the reference kind we followed.
/** @typedef {"manifest" | "module" | "classic" | "html" | "asset" | "locale"} ShippingKind */

/**
 * @typedef {object} ShippingFile
 * @property {string} path POSIX path relative to the extension root
 * @property {ShippingKind} kind
 * @property {Buffer} bytes
 * @property {string} sha256
 * @property {string[]} referrers files that reach this one
 */

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosix(path) {
  return path.split(sep).join(posix.sep);
}

/**
 * Follow references from a file's directory, staying inside the root.
 * @param {string} root
 * @param {string} fromPath POSIX path of the referring file
 * @param {string} specifier
 */
function resolveReference(root, fromPath, specifier) {
  const target = specifier.startsWith("/")
    ? posix.normalize(specifier.slice(1))
    : posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  if (target.startsWith("../") || target === "..") {
    throw new Error(
      `${fromPath} references ${specifier}, which escapes the extension root`,
    );
  }
  const absolute = resolve(root, ...target.split(posix.sep));
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`${fromPath} references missing file ${target}`);
  }
  return target;
}

function isDevelopmentOnly(path) {
  const head = path.split(posix.sep)[0];
  return DEVELOPMENT_ONLY.includes(head);
}

/** ES module syntax present in a file that Chrome will execute as a classic script. */
function moduleSyntaxNodes(file) {
  const found = [];
  visit(file, (node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node) ||
      (ts.canHaveModifiers(node) &&
        (ts.getModifiers(node) ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ))
    ) {
      found.push(node.getText(file).split("\n")[0]);
    }
  });
  return found;
}

/**
 * Static references from a JavaScript module: import/export specifiers,
 * constant dynamic imports, and constant extension-page paths (`*.html`).
 * @param {string} source
 * @param {string} path
 */
export function moduleReferences(source, path) {
  const file = parseSource(source, path);
  const syntaxErrors =
    /** @type {{ messageText: string | ts.DiagnosticMessageChain }[]} */ (
      /** @type {{ parseDiagnostics?: unknown[] }} */ (
        /** @type {unknown} */ (file)
      ).parseDiagnostics ?? []
    );
  if (syntaxErrors.length > 0) {
    throw new Error(
      `${path} does not parse: ${ts.flattenDiagnosticMessageText(
        syntaxErrors[0].messageText,
        " ",
      )}`,
    );
  }
  /** @type {{ specifier: string, kind: ShippingKind }[]} */
  const references = [];
  visit(file, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      const specifier = constantString(node.moduleSpecifier);
      if (specifier === null) {
        throw new Error(`${path} has a non-constant module specifier`);
      }
      references.push({ specifier, kind: "module" });
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = node.arguments[0]
        ? constantString(node.arguments[0])
        : null;
      if (specifier === null) {
        throw new Error(`${path} has a non-constant dynamic import`);
      }
      references.push({ specifier, kind: "module" });
      return;
    }
    if (ts.isStringLiteral(node) && /^[\w./-]+\.html$/.test(node.text)) {
      references.push({ specifier: node.text, kind: "html" });
    }
  });
  return references;
}

/**
 * Static references from an extension page: script sources, stylesheets and
 * images with relative paths.
 * @param {string} source
 */
export function htmlReferences(source) {
  /** @type {{ specifier: string, kind: ShippingKind }[]} */
  const references = [];
  for (const match of source.matchAll(
    /<script\b([^>]*)\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
  )) {
    const isModule = /\btype\s*=\s*["']module["']/i.test(match[1]);
    if (!isModule) {
      throw new Error(
        `extension page loads ${match[2]} as a classic script; pages ship module scripts only`,
      );
    }
    references.push({ specifier: match[2], kind: "module" });
  }
  for (const match of source.matchAll(
    /<(?:link|img)\b[^>]*\s(?:href|src)\s*=\s*["']([^"':]+)["'][^>]*>/gi,
  )) {
    references.push({ specifier: match[1], kind: "asset" });
  }
  return references;
}

/**
 * Collect every file the manifest reaches, verifying each the way Chrome will
 * load it. Throws on the first defect (fail closed).
 * @param {string} root absolute extension root
 */
export function collectShipping(root) {
  const manifestBytes = readFileSync(join(root, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  /** @type {Map<string, ShippingFile>} */
  const files = new Map();
  /** @type {{ path: string, kind: ShippingKind, referrer: string }[]} */
  const queue = [];
  const enqueue = (referrer, specifier, kind) => {
    const path = resolveReference(root, referrer, specifier);
    queue.push({ path, kind, referrer });
  };

  files.set("manifest.json", {
    path: "manifest.json",
    kind: "manifest",
    bytes: manifestBytes,
    sha256: sha256(manifestBytes),
    referrers: [],
  });
  const worker = manifest.background?.service_worker;
  if (typeof worker !== "string" || manifest.background?.type !== "module") {
    throw new Error("manifest must declare a module background service worker");
  }
  enqueue("manifest.json", worker, "module");
  for (const entry of manifest.content_scripts ?? []) {
    for (const js of entry.js ?? []) enqueue("manifest.json", js, "classic");
    for (const css of entry.css ?? []) enqueue("manifest.json", css, "asset");
  }
  const popup = manifest.action?.default_popup;
  if (typeof popup === "string") enqueue("manifest.json", popup, "html");
  for (const icon of Object.values(manifest.icons ?? {})) {
    enqueue("manifest.json", String(icon), "asset");
  }
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) {
    enqueue("manifest.json", String(icon), "asset");
  }
  for (const key of ["options_page", "devtools_page", "chrome_url_overrides"]) {
    if (key in manifest) {
      throw new Error(`manifest key ${key} is not part of the shipping model`);
    }
  }
  if (manifest.web_accessible_resources) {
    throw new Error(
      "web_accessible_resources is not part of the shipping model",
    );
  }
  if (typeof manifest.default_locale === "string") {
    const localesRoot = join(root, "_locales");
    for (const locale of readdirSync(localesRoot).sort()) {
      const messages = join(localesRoot, locale, "messages.json");
      let messagesText;
      try {
        messagesText = readFileSync(messages, "utf8");
      } catch (err) {
        if (err && (err.code === "ENOENT" || err.code === "EISDIR")) {
          throw new Error(`_locales/${locale} has no messages.json`);
        }
        throw err;
      }
      JSON.parse(messagesText);
      queue.push({
        path: toPosix(relative(root, messages)),
        kind: "locale",
        referrer: "manifest.json",
      });
    }
    const defaultPath = `_locales/${manifest.default_locale}/messages.json`;
    if (!queue.some((item) => item.path === defaultPath)) {
      throw new Error(`default_locale ${manifest.default_locale} missing`);
    }
  }

  while (queue.length > 0) {
    const item =
      /** @type {{ path: string, kind: ShippingKind, referrer: string }} */ (
        queue.shift()
      );
    if (isDevelopmentOnly(item.path)) {
      throw new Error(
        `${item.referrer} reaches development-only file ${item.path}`,
      );
    }
    const known = files.get(item.path);
    if (known) {
      if (known.kind !== item.kind && known.kind !== "asset") {
        throw new Error(
          `${item.path} is loaded both as ${known.kind} and as ${item.kind}`,
        );
      }
      if (!known.referrers.includes(item.referrer)) {
        known.referrers.push(item.referrer);
      }
      continue;
    }
    const bytes = readFileSync(join(root, ...item.path.split(posix.sep)));
    files.set(item.path, {
      path: item.path,
      kind: item.kind,
      bytes,
      sha256: sha256(bytes),
      referrers: [item.referrer],
    });
    if (item.kind === "module") {
      for (const reference of moduleReferences(
        bytes.toString("utf8"),
        item.path,
      )) {
        enqueue(item.path, reference.specifier, reference.kind);
      }
    } else if (item.kind === "classic") {
      const source = bytes.toString("utf8");
      const moduleSyntax = moduleSyntaxNodes(parseSource(source, item.path));
      if (moduleSyntax.length > 0) {
        throw new Error(
          `${item.path} is a classic content script but contains ES module syntax: ${moduleSyntax[0]}`,
        );
      }
      // Compile the exact bytes as a classic script, as Chrome will.
      try {
        new Script(source, { filename: item.path });
      } catch (error) {
        throw new Error(
          `${item.path} does not compile as a classic script: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    } else if (item.kind === "html") {
      for (const reference of htmlReferences(bytes.toString("utf8"))) {
        enqueue(item.path, reference.specifier, reference.kind);
      }
    }
  }
  return {
    manifest,
    files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

// ---- deterministic zip (STORE only) -----------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Fixed DOS timestamp 1980-01-01 00:00:00 so the archive depends only on content.
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

/**
 * Build a deterministic, uncompressed zip: entries sorted by path, fixed
 * timestamps, no extra fields, no comments, no directory entries.
 * @param {{ path: string, bytes: Buffer }[]} entries
 */
export function buildZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of sorted) {
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // version needed: 1.0 (store)
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(10, 4); // version made by: MS-DOS host, 1.0
    central.writeUInt16LE(10, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.bytes);
    centrals.push(central, name);
    offset += local.length + name.length + entry.bytes.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, end]);
}

/**
 * Read a STORE-only zip produced by buildZip (or any stored archive) back into
 * entries, verifying each CRC. Used to prove the archive round-trips and to
 * extract the exact shipping bytes for the browser loader.
 * @param {Buffer} zip
 */
export function readZip(zip) {
  const endOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error("zip: no end of central directory");
  const count = zip.readUInt16LE(endOffset + 10);
  let cursor = zip.readUInt32LE(endOffset + 16);
  /** @type {{ path: string, bytes: Buffer }[]} */
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("zip: bad central directory entry");
    }
    const method = zip.readUInt16LE(cursor + 10);
    if (method !== 0) throw new Error("zip: only stored entries are supported");
    const crc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const path = zip.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`zip: bad local header for ${path}`);
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const bytes = zip.subarray(start, start + size);
    if (crc32(bytes) !== crc) throw new Error(`zip: CRC mismatch for ${path}`);
    if (path.includes("..") || path.startsWith("/")) {
      throw new Error(`zip: unsafe entry path ${path}`);
    }
    entries.push({ path, bytes: Buffer.from(bytes) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Write zip entries to a directory (used to load the exact package in a browser).
 * @param {{ path: string, bytes: Buffer }[]} entries
 * @param {string} directory
 * @param {{ mkdirSync: typeof import("node:fs").mkdirSync, writeFileSync: typeof import("node:fs").writeFileSync }} fs
 */
export function extractEntries(entries, directory, fs) {
  for (const entry of entries) {
    const target = join(directory, ...entry.path.split(posix.sep));
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.bytes);
  }
}
