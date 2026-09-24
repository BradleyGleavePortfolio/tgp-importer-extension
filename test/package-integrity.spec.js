// The shipping package is defined by the manifest's load closure and must be
// reproducible, bounded and free of development-only code. These tests run the
// real packager against the real tree, then prove the packager fails closed on
// the defect classes that would otherwise ship silently (including the exact
// classic-script/ESM defect that broke main's content script).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEVELOPMENT_ONLY,
  buildZip,
  collectShipping,
  extractEntries,
  readZip,
  sha256,
} from "../scripts/lib/shipping.mjs";
import { packageExtension } from "../scripts/package-extension.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "tgp-package-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Frozen permission surface. Widening any of these is a Tier 4 change that must
// be made here deliberately, never by editing manifest.json alone.
const REQUIRED_PERMISSIONS = [
  "activeTab",
  "debugger",
  "notifications",
  "storage",
  "tabs",
];
const REQUIRED_HOSTS = [
  "https://*.truecoach.co/*",
  "https://api.tgp.coach/*",
  "https://app.truecoach.co/*",
];
const BROAD = /^(?:<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*)$/;

/** Minimal synthetic extension tree for fail-closed cases. */
function syntheticTree(name, files) {
  const dir = join(scratch, name);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), source);
  }
  return dir;
}
const baseManifest = {
  manifest_version: 3,
  name: "synthetic",
  version: "0.0.1",
  background: { service_worker: "background.js", type: "module" },
  content_scripts: [{ matches: ["https://example.test/*"], js: ["cs.js"] }],
};
const baseFiles = {
  "manifest.json": JSON.stringify(baseManifest),
  "background.js": 'import { a } from "./shared/a.js";\nconsole.log(a);\n',
  "shared/a.js": "export const a = 1;\n",
  "cs.js": "(() => { console.log('classic'); })();\n",
};

describe("package: reproducible shipping bytes", { timeout: 30_000 }, () => {
  const first = packageExtension(root, join(scratch, "build-1"));
  const second = packageExtension(root, join(scratch, "build-2"));

  it("produces byte-identical archives and inventories from the same tree", () => {
    expect(second.zip.sha256).toBe(first.zip.sha256);
    expect(second.files).toEqual(first.files);
    expect(first.files.length).toBeGreaterThan(20);
  });

  it("round-trips the archive to the exact shipped bytes", () => {
    const { files } = collectShipping(root);
    const zip = buildZip(files);
    expect(sha256(zip)).toBe(first.zip.sha256);
    const restored = readZip(zip);
    expect(restored.map((entry) => entry.path)).toEqual(
      files.map((file) => file.path),
    );
    for (const [index, entry] of restored.entries()) {
      expect(entry.bytes.equals(files[index].bytes)).toBe(true);
    }
    // A corrupted byte in any entry is detected, not shipped.
    const corrupt = Buffer.from(zip);
    corrupt[zip.indexOf(files[0].bytes) + 3] ^= 0xff;
    expect(() => readZip(corrupt)).toThrow(/CRC mismatch/);
  });

  it("ships only manifest-reachable runtime files, never development trees", () => {
    const paths = first.files.map((file) => file.path);
    for (const path of paths) {
      expect(DEVELOPMENT_ONLY).not.toContain(path.split("/")[0]);
      expect(path).not.toMatch(
        /(?:\.spec\.js|\.mjs|\.py|\.md|\.d\.ts|\.yml|\.lock)$|^(?:package(?:-lock)?\.json|jsconfig.*|README\.md|types\.d\.ts)$/,
      );
    }
    expect(paths).toContain("manifest.json");
    expect(paths).toContain("background.js");
    expect(paths).toContain("content/main.js");
    expect(paths).toContain("popup/popup.html");
    expect(paths).toContain("popup/pair.html");
    expect(paths).toContain("_locales/en/messages.json");
    expect(
      first.files.find((file) => file.path === "content/main.js")?.kind,
    ).toBe("classic");
  });

  it("the fixture/mock reference pattern matches a bare and a nested specifier", () => {
    const fixtureRef =
      /["'](?:[^"']*\/)?(?:test\/fixtures|fixtures|__mocks__|mocks)\/[^"']*["']/;
    expect('"fixtures/a.json"').toMatch(fixtureRef);
    expect('"src/nested/fixtures/a.json"').toMatch(fixtureRef);
  });

  it("contains no Node, test-runner or fixture references in shipped code", () => {
    const { files } = collectShipping(root);
    for (const file of files) {
      if (!/\.(?:js|html)$/.test(file.path)) continue;
      const source = file.bytes.toString("utf8");
      expect(source, file.path).not.toMatch(/["']node:[a-z_/]+["']/);
      expect(source, file.path).not.toMatch(/\bprocess\.env\b|\bvitest\b/);
      expect(source, file.path).not.toMatch(
        /["'](?:[^"']*\/)?(?:test\/fixtures|fixtures|__mocks__|mocks)\/[^"']*["']/,
      );
    }
  });
});

describe("package: bounded manifest surface", () => {
  const { manifest } = collectShipping(root);

  it("holds required permissions and host origins to the frozen sets", () => {
    expect([...manifest.permissions].sort()).toEqual(REQUIRED_PERMISSIONS);
    expect([...manifest.host_permissions].sort()).toEqual(REQUIRED_HOSTS);
    for (const pattern of [
      ...manifest.permissions,
      ...manifest.host_permissions,
    ]) {
      expect(pattern).not.toMatch(BROAD);
    }
  });

  it("keeps any broad origin optional, so it needs a user gesture at runtime", () => {
    const optional = manifest.optional_host_permissions ?? [];
    expect(optional.length).toBeLessThanOrEqual(1);
    expect(manifest.host_permissions).not.toEqual(
      expect.arrayContaining(optional),
    );
  });

  it("injects the classic content script only on declared source origins", () => {
    expect(manifest.content_scripts).toHaveLength(1);
    const [entry] = manifest.content_scripts;
    for (const match of entry.matches) {
      expect(manifest.host_permissions).toContain(match);
      expect(match.startsWith("https://")).toBe(true);
    }
    expect(entry.all_frames).toBeUndefined();
    expect(entry.match_about_blank).toBeUndefined();
    expect(entry.js).toEqual(["content/main.js"]);
  });

  it("exposes no external message or web-accessible surface", () => {
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.background.type).toBe("module");
    expect(manifest.minimum_chrome_version).toMatch(/^\d+$/);
    expect(manifest.content_security_policy).toBeUndefined();
  });
});

describe("package: loader fails closed", { timeout: 30_000 }, () => {
  it("rejects the historical defect: ESM syntax in the classic content script", () => {
    // Rebuild the real package into a scratch tree, then reintroduce exactly
    // the main-branch defect (an ES export in content/main.js).
    const dir = join(scratch, "real-with-export");
    const { files } = collectShipping(root);
    extractEntries(files, dir, { mkdirSync, writeFileSync });
    const real = collectShipping(dir);
    expect(real.files.map((file) => file.sha256)).toEqual(
      files.map((file) => file.sha256),
    );
    writeFileSync(
      join(dir, "content/main.js"),
      `${files.find((file) => file.path === "content/main.js")?.bytes.toString("utf8")}\nexport const readSourceBearer = () => "";\n`,
    );
    expect(() => collectShipping(dir)).toThrow(
      /content\/main\.js is a classic content script but contains ES module syntax/,
    );
  });

  it("accepts the synthetic baseline, proving the negative cases are not vacuous", () => {
    const dir = syntheticTree("ok", baseFiles);
    expect(collectShipping(dir).files.map((file) => file.path)).toEqual([
      "background.js",
      "cs.js",
      "manifest.json",
      "shared/a.js",
    ]);
  });

  it("rejects a content script that does not compile as a classic script", () => {
    const dir = syntheticTree("cs-syntax", {
      ...baseFiles,
      "cs.js": "(() => { const = 1; })();\n",
    });
    expect(() => collectShipping(dir)).toThrow(
      /cs\.js does not compile as a classic script/,
    );
  });

  it("rejects a module graph that reaches a missing file", () => {
    const dir = syntheticTree("missing", {
      ...baseFiles,
      "background.js": 'import "./shared/gone.js";\n',
    });
    expect(() => collectShipping(dir)).toThrow(
      /background\.js references missing file shared\/gone\.js/,
    );
  });

  it("rejects a module graph that reaches a development-only tree", () => {
    const dir = syntheticTree("devtree", {
      ...baseFiles,
      "background.js": 'import "./test/helper.js";\n',
      "test/helper.js": "export {};\n",
    });
    expect(() => collectShipping(dir)).toThrow(
      /reaches development-only file test\/helper\.js/,
    );
  });

  it("rejects references that escape the extension root", () => {
    const dir = syntheticTree("escape", {
      ...baseFiles,
      "background.js": 'import "../outside.js";\n',
    });
    writeFileSync(join(scratch, "outside.js"), "export {};\n");
    expect(() => collectShipping(dir)).toThrow(/escapes the extension root/);
  });

  it("rejects a non-module service worker and classic page scripts", () => {
    const worker = syntheticTree("classic-worker", {
      ...baseFiles,
      "manifest.json": JSON.stringify({
        ...baseManifest,
        background: { service_worker: "background.js" },
      }),
    });
    expect(() => collectShipping(worker)).toThrow(/module background/);
    const page = syntheticTree("classic-page", {
      ...baseFiles,
      "manifest.json": JSON.stringify({
        ...baseManifest,
        action: { default_popup: "popup.html" },
      }),
      "popup.html": '<script src="popup.js"></script>',
      "popup.js": "",
    });
    expect(() => collectShipping(page)).toThrow(/classic script/);
  });
});
