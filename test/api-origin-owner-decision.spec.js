import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TGP_API_ORIGIN, isTgpOrigin } from "../shared/protocol.js";

// Owner decision OD-API-ORIGIN (2026-09-29): the extension's TGP backend is
// the Fly app the mobile client already uses. The previous vanity domain was
// never registered, so any shipped reference to it would both break every call
// and hand pairing codes, tokens and client data to whoever registers it.
// This test FAILS on 142501a, where the manifest and shared/protocol.js still
// named that domain.

const root = fileURLToPath(new URL("..", import.meta.url));
const FLY_ORIGIN = "https://backend-spring-lake-3890.fly.dev";
// Spelled without a literal so this file is not itself a reference.
const RETIRED_DOMAIN = ["tgp", "coach"].join(".");
const SHIPPED = [
  "manifest.json",
  "background.js",
  "shared",
  "popup",
  "content",
];

function* walk(path) {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) yield* walk(join(path, name));
  } else {
    yield path;
  }
}

describe("OD-API-ORIGIN — the TGP backend origin is the Fly app", () => {
  it("TGP_API_ORIGIN is the Fly backend", () => {
    expect(TGP_API_ORIGIN).toBe(FLY_ORIGIN);
  });

  it("the manifest's required host is exactly that origin", () => {
    const manifest = JSON.parse(
      readFileSync(join(root, "manifest.json"), "utf8"),
    );
    expect(manifest.host_permissions).toEqual([`${FLY_ORIGIN}/*`]);
  });

  it("X1 refuses the new TGP origin as a source (never self-import)", () => {
    expect(isTgpOrigin(FLY_ORIGIN)).toBe(true);
    expect(isTgpOrigin(`${FLY_ORIGIN}/api/scout/ingest`)).toBe(true);
    // Shared hosting domain: no sibling app is TGP.
    expect(isTgpOrigin("https://someone-else.fly.dev")).toBe(false);
  });

  it("no shipped file references the retired domain", () => {
    const offenders = [];
    for (const entry of SHIPPED) {
      for (const file of walk(join(root, entry))) {
        const text = readFileSync(file, "utf8");
        if (text.toLowerCase().includes(RETIRED_DOMAIN)) {
          offenders.push(relative(root, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
