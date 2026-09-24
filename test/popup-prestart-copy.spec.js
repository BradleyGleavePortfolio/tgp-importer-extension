import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installChrome, makeBgMock } from "./helpers/background-mock.js";
import { preStartIssue } from "../popup/outcome.js";

const en = JSON.parse(
  readFileSync(join(process.cwd(), "_locales/en/messages.json"), "utf8"),
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Minimal getMessage stand-in over the real catalog so unit tests exercise the
// actual approved strings without booting chrome.i18n.
function messageFrom(catalog) {
  return (key) => catalog[key]?.message ?? "";
}

const noRun = {
  kind: "status_snapshot",
  intent: null,
  progress: [],
  lastError: null,
};

describe("preStartIssue — no-run error family mapping", () => {
  const message = messageFrom(en);

  it.each([
    [
      "import stopped — your TGP session changed during the import. Start the import again.",
      "prestart_session_changed",
    ],
    ["auth_required", "prestart_pairing_needed"],
    ["login required to import", "prestart_pairing_needed"],
    ["session expired — please sign in again", "prestart_pairing_needed"],
    ["unsupported site: https://example.com", "prestart_page_unsupported"],
    ["unsafe import origin: https://example.com", "prestart_unsafe_origin"],
    ["no extractor for truecoach", "prestart_no_reader"],
    ["no blueprint for truecoach", "prestart_site_setup_unavailable"],
    ["blueprint resolve failed", "prestart_site_setup_unavailable"],
  ])("maps %j to the approved key %s", (lastError, key) => {
    expect(preStartIssue(lastError, message)).toBe(message(key));
  });

  it.each([
    "ingest_ack_invalid",
    "complete: settlement failed",
    "some pages skipped",
    "totally unrecognised worker detail",
    "",
    null,
    undefined,
  ])("falls back to one generic line for unrecognised detail (%j)", (raw) => {
    expect(preStartIssue(raw, message)).toBe(message("prestart_unknown"));
  });

  it("never echoes a platform/vendor slug for the no-reader family", () => {
    const result = preStartIssue("no extractor for truecoach", message);
    expect(result).not.toContain("truecoach");
    expect(result).not.toContain("no extractor for");
  });

  it("never echoes the tab origin for unsupported or unsafe origins", () => {
    const unsupported = preStartIssue(
      "unsupported site: https://app.truecoach.co/clients",
      message,
    );
    const unsafe = preStartIssue(
      "unsafe import origin: https://app.truecoach.co/clients",
      message,
    );
    for (const text of [unsupported, unsafe]) {
      expect(text).not.toContain("truecoach");
      expect(text).not.toContain("https://");
    }
  });

  it("never echoes raw worker text for any of the seven known families", () => {
    const raws = [
      "import stopped — your TGP session changed during the import. Start the import again.",
      "auth_required",
      "unsupported site: https://app.truecoach.co/clients",
      "unsafe import origin: https://app.truecoach.co/clients",
      "no extractor for truecoach",
      "no blueprint for truecoach",
      "blueprint resolve failed",
    ];
    for (const raw of raws) {
      expect(preStartIssue(raw, message)).not.toBe(raw);
    }
  });
});

describe("popup no-run error box renders only approved copy", () => {
  function testDocument() {
    function node() {
      let text = "";
      const handlers = new Map();
      const children = [];
      return {
        hidden: false,
        disabled: false,
        className: "",
        dataset: {},
        children,
        get textContent() {
          return text;
        },
        set textContent(value) {
          text = value;
          children.length = 0;
        },
        appendChild(child) {
          children.push(child);
        },
        addEventListener(type, handler) {
          handlers.set(type, handler);
        },
        click() {
          return handlers.get("click")?.();
        },
      };
    }
    const nodes = new Map();
    const doc = {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, node());
        return nodes.get(id);
      },
      createElement: node,
      querySelectorAll: () => [],
    };
    return { doc, nodes };
  }

  async function popup(snapshot) {
    vi.resetModules();
    const { doc, nodes } = testDocument();
    const mock = makeBgMock();
    const sendMessage = vi.fn((request, callback = (_response) => {}) => {
      const response =
        request.kind === "request_session_state"
          ? { ok: true, hasSession: true }
          : snapshot;
      if (callback) callback(response);
      return Promise.resolve(response);
    });
    mock.chrome.runtime.sendMessage = sendMessage;
    vi.stubGlobal("document", doc);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
    installChrome(mock);
    await import("../popup/popup.js");
    return { mock, nodes, sendMessage };
  }

  it.each([
    [
      "import stopped — your TGP session changed during the import. Start the import again.",
      "prestart_session_changed",
    ],
    ["auth_required", "prestart_pairing_needed"],
    [
      "unsupported site: https://app.truecoach.co/clients",
      "prestart_page_unsupported",
    ],
    [
      "unsafe import origin: https://app.truecoach.co/clients",
      "prestart_unsafe_origin",
    ],
    ["no extractor for truecoach", "prestart_no_reader"],
    ["no blueprint for truecoach", "prestart_site_setup_unavailable"],
    ["blueprint resolve failed", "prestart_site_setup_unavailable"],
  ])(
    "shows the approved line for %j, never the raw detail",
    async (raw, key) => {
      const result = await popup({ ...noRun, lastError: raw });
      const errorBox = result.nodes.get("error");
      expect(errorBox.hidden).toBe(false);
      expect(errorBox.textContent).toBe(en[key].message);
      expect(errorBox.textContent).not.toBe(raw);
      expect(errorBox.textContent).not.toContain("truecoach");
    },
  );

  it("shows one generic line for an unrecognised no-run error", async () => {
    const result = await popup({
      ...noRun,
      lastError: "some completely novel worker detail",
    });
    const errorBox = result.nodes.get("error");
    expect(errorBox.hidden).toBe(false);
    expect(errorBox.textContent).toBe(en.prestart_unknown.message);
  });

  it("hides the error box when there is no error", async () => {
    const result = await popup(noRun);
    expect(result.nodes.get("error").hidden).toBe(true);
  });

  it("hides the pre-start error box once a run is present (run-path copy owns that state)", async () => {
    const result = await popup({
      kind: "status_snapshot",
      intent: {
        intentId: "local-test",
        platform: "truecoach",
        status: "ingest_failed",
      },
      progress: [],
      lastError: "ingest_ack_invalid",
    });
    expect(result.nodes.get("error").hidden).toBe(true);
  });
});
