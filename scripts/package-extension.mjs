// Build the reproducible extension package from the manifest's shipping closure.
//
// Usage: node scripts/package-extension.mjs [--out dist] [--root .]
//
// Writes:
//   dist/tgp-importer-extension-<version_name>.zip        stored, deterministic
//   dist/tgp-importer-extension-<version_name>.inventory.json
//
// The inventory binds the archive hash to every shipped file hash and to the
// source commit it was built from. Two builds of the same tree produce the same
// bytes, so the zip sha256 alone identifies the shipped source. Nothing here
// proves the extension imports customer data; it proves what would be shipped.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildZip, collectShipping, readZip, sha256 } from "./lib/shipping.mjs";

function argument(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

/** @param {string} root */
function describeSource(root) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { head, clean: status.trim().length === 0 };
  } catch (error) {
    return {
      head: null,
      clean: null,
      note: `git unavailable: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}

/**
 * @param {string} root
 * @param {string} out
 */
export function packageExtension(root, out) {
  const { manifest, files } = collectShipping(root);
  const zip = buildZip(files);
  // Round-trip the archive we are about to publish so a writer defect cannot
  // ship silently.
  const restored = readZip(zip);
  if (restored.length !== files.length) {
    throw new Error("zip round-trip lost entries");
  }
  for (const [index, entry] of restored.entries()) {
    if (
      entry.path !== files[index].path ||
      !entry.bytes.equals(files[index].bytes)
    ) {
      throw new Error(`zip round-trip changed ${files[index].path}`);
    }
  }
  const name = `tgp-importer-extension-${manifest.version_name ?? manifest.version}`;
  const inventory = {
    name: manifest.name,
    version: manifest.version,
    version_name: manifest.version_name ?? null,
    manifest_version: manifest.manifest_version,
    source: describeSource(root),
    zip: { file: `${name}.zip`, bytes: zip.length, sha256: sha256(zip) },
    files: files.map((file) => ({
      path: file.path,
      kind: file.kind,
      bytes: file.bytes.length,
      sha256: file.sha256,
      referrers: file.referrers,
    })),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}.zip`), zip);
  writeFileSync(
    join(out, `${name}.inventory.json`),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  return inventory;
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")
) {
  const root = resolve(argument("--root", "."));
  const out = resolve(argument("--out", "dist"));
  const inventory = packageExtension(root, out);
  process.stdout.write(
    `packaged ${inventory.files.length} files -> ${out}/${inventory.zip.file}\n` +
      `zip sha256 ${inventory.zip.sha256} (${inventory.zip.bytes} bytes)\n` +
      `source ${inventory.source.head ?? "unknown"}${inventory.source.clean === false ? " (dirty tree)" : ""}\n`,
  );
}
