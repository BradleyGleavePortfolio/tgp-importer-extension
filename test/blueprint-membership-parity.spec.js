import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { inferUrlTemplates } from "../shared/blueprint/url-templates.js";
import { validateObservationMembership } from "../shared/blueprint/membership.js";

// Pinned pre-membership algorithm; no network or generated baseline fixtures.
const BASE = "0111be661922234d670bbf23e23d270eec1b4a4e";
const sourceAt = (file) =>
  execFileSync("git", ["show", `${BASE}:shared/blueprint/${file}`], {
    encoding: "utf8",
  });
const moduleUrl = (text) =>
  `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;

it("matches the pinned algorithm and accounts for every position in 5000 seeded cases", async () => {
  const legacy = await import(
    moduleUrl(
      sourceAt("url-templates.js").replace(
        '"./order.js"',
        JSON.stringify(moduleUrl(sourceAt("order.js"))),
      ),
    )
  );
  let seed = 0xc2b00b;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const paths = [
    "/clients/101",
    "/clients/102",
    "/clients/103",
    "/workouts/201",
    "/workouts/202",
    "/workouts/203",
    "/v1/1",
    "/V1/2",
    "/v1/3",
    "/2025/01",
    "/2025/02",
    "/2025/03",
    "/x/%3Aid",
    "/x/:id",
    "/x/caf%C3%A9",
    "/x/cafe%CC%81",
    "/x/café",
    "/x/1.2",
    "/x/1.3",
    "/x/2026-01",
    "/x/abc123",
    "/x/def456",
    "/x/ghi789",
    "/x/%2F",
    "/x/%GG",
    "/x/",
    "//bad",
    "/bad?x=1",
  ];
  const settings = [
    undefined,
    {},
    { minDistinct: 2 },
    { minDistinct: 4 },
    { maxObservations: 3 },
    { maxSegments: 1 },
    { membership: false },
    { membership: "true" },
    { maxObservations: 1, minDistinct: 2 },
    { maxSegments: 2 },
  ];
  let cases = 0;
  for (let snapshot = 0; snapshot < 500; snapshot++) {
    const rows = Array.from({ length: 1 + random(20) }, () => {
      const kind = random(13);
      if (kind === 0) return null;
      if (kind === 1) return "non-record";
      return {
        origin:
          random(7) === 0 ? "http://unsafe.example" : "https://coach.example",
        method: random(7) === 0 ? "POST" : "GET",
        path: paths[random(paths.length)],
        queryKeys: random(2) === 0 ? ["PAGE", "cursor", "ignored"] : [],
      };
    });
    if (snapshot % 7 === 0) delete rows[0];
    for (const options of settings) {
      const expected = legacy.inferUrlTemplates(rows, options);
      expect(JSON.stringify(inferUrlTemplates(rows, options))).toBe(
        JSON.stringify(expected),
      );
      const { membership, ...plain } = inferUrlTemplates(rows, {
        ...options,
        membership: true,
      });
      expect(JSON.stringify(plain)).toBe(JSON.stringify(expected));
      expect(membership.observationCount).toBe(rows.length);
      const refs = [...membership.excluded.map((entry) => entry.ref)];
      for (const [index, entry] of membership.clusters.entries()) {
        expect(entry.refs).toEqual([...entry.refs].sort((a, b) => a - b));
        expect(entry.refs).toHaveLength(plain.clusters[index].observations);
        refs.push(...entry.refs);
      }
      expect(refs.sort((a, b) => a - b)).toEqual(
        Array.from({ length: rows.length }, (_, index) => index),
      );
      expect(
        validateObservationMembership(rows, membership, options).reasons,
      ).toEqual([]);
      cases++;
    }
  }
  expect(cases).toBe(5000);
}, 30000);
