// Test-only helpers for the learn lane (X2): load the synthetic parity capture,
// turn the conformance_alpha response map into a redacted capture, and walk a
// fixture for every VALUE it contains so the digest can be proven value-free.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function loadParityFixture() {
  const path = fileURLToPath(
    new URL("../fixtures/learn/legacy-parity-capture.json", import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadFingerprintVectors() {
  const path = fileURLToPath(
    new URL("../fixtures/learn/fingerprint-vectors.json", import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

// One GET entry per recorded response; `?after=` keys keep their cursor so the
// query VALUE is present in the capture (and must be absent from the digest).
export function conformanceCapture(fixture) {
  return Object.entries(fixture.responses).map(([key, body], index) => ({
    url: `${fixture.apiBase}${key}`,
    method: "GET",
    statusCode: 200,
    capturedAt: `2026-07-02T00:00:${String(index).padStart(2, "0")}.000Z`,
    requestHeaders: {
      Accept: "application/json",
      Authorization: "<redacted>",
      "X-Client-Build": "2026.07",
    },
    responseBody: JSON.stringify(body),
  }));
}

function walk(value, out) {
  if (typeof value === "string") out.add(value);
  else if (typeof value === "number") out.add(String(value));
  else if (Array.isArray(value)) value.forEach((item) => walk(item, out));
  else if (value && typeof value === "object")
    Object.values(value).forEach((item) => walk(item, out));
}

// Every value a capture carries: body leaves, header values, full URLs, query
// values and path segments that are not plain words.
export function captureValues(capture) {
  const out = new Set();
  for (const entry of capture) {
    walk(JSON.parse(entry.responseBody), out);
    for (const value of Object.values(entry.requestHeaders ?? {}))
      out.add(value);
    out.add(entry.url);
    const url = new URL(entry.url);
    for (const [, value] of url.searchParams) out.add(value);
    for (const segment of url.pathname.split("/"))
      if (/\d|@/.test(segment)) out.add(segment);
  }
  return out;
}

// Values long enough to be a meaningful substring probe (short numbers and
// redaction markers are skipped: "1" appears in `digestVersion: 1`).
export function probeValues(values) {
  return [...values].filter(
    (value) =>
      value.length >= 3 && !/^(?:<redacted>|\[redacted\])$/i.test(value),
  );
}

export function assertValueFree(text, values, expect) {
  for (const value of probeValues(values)) {
    expect(text, `value "${value}" leaked into the digest`).not.toContain(
      value,
    );
    expect(
      text,
      `encoded value "${value}" leaked into the digest`,
    ).not.toContain(encodeURIComponent(value));
  }
}
