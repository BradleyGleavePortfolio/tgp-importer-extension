# C2b-0B — observation ↔ cluster membership provenance

Shared, opt-in provenance seam so later inference layers (`roles.js`, `edges.js`,
`pagination.js`, confidence, compiler) can relate a URL cluster back to the exact
capture observations that produced it, without any consumer re-implementing a
second URL/path matcher. Primitive only: nothing here is wired to runtime, UI,
adapters, replay or production flags.

## Producer API — `shared/blueprint/url-templates.js`

```js
const result = inferUrlTemplates(observations, { membership: true });
```

`observations` is the array produced by `normalizeCaptureSnapshot(...).observations`
(same contract as before: `{origin, path, queryKeys, method, ...}`).

- Without `membership: true` (including `membership: false` or any non-boolean
  value) the returned shape remains `{clusters, excluded}` with no extra key.
  For inert data within the text limits below, clustering and exclusions retain
  the previous byte-level behaviour. Active objects and inherited fields are
  deliberately not part of that compatibility contract.
- With `membership: true`, one additional key is added:

```js
result.membership = {
  observationCount: 6,                 // observations.length at derivation time
  clusters: [                          // index-aligned with result.clusters
    {
      origin: "https://coach.example",
      method: "GET",
      pathPattern: "/clients/:id",
      refs: [0, 1, 2],                 // ascending indices into `observations`
    },
  ],
  excluded: [                          // ascending by ref
    { ref: 3, reason: "invalid_observation" },
    { ref: 4, reason: "observation_limit" },
  ],
};
```

### Reference semantics

- **Snapshot-local only.** A `ref` is an index into the exact `observations`
  array passed to `inferUrlTemplates`. It is not a hash, not derived from any
  captured value, and carries no PII, body, query value, credential or header
  value. It is meaningless outside its snapshot and must never be persisted or
  transmitted as a stable identifier.
- **Lifetime.** Valid only for the identity and length of that array. Any
  mutation, re-normalization, or a different snapshot invalidates it; validation
  rejects a mismatched length with `stale_observation_count`.
- **Exact attribution.** Every accepted observation appears in exactly one
  cluster; every rejected or capped observation appears exactly once in
  `membership.excluded`. No reference is shared between two clusters, and none
  is both supporting and excluded.
- **Duplicate multiplicity.** Two identical observations remain two references,
  so support counts equal observation counts (`refs.length ===
  cluster.observations`), not distinct-URL counts.
- **Deterministic ordering.** `membership.clusters` follows the canonical cluster
  order; `refs` and `excluded` are ascending. Clustering itself is unchanged: row
  ordering, dynamic-segment grouping, partitioning and deterministic truncation
  retain the previous algorithm. The committed
  `test/blueprint-membership-parity.spec.js` provides a reproducible check against
  pre-membership commit `0111be661922234d670bbf23e23d270eec1b4a4e`: 500 seeded
  snapshots across ten option sets, including holes, invalid rows, Unicode,
  calendar partitions and truncation. It also checks exact positional coverage
  and validator acceptance. Run `npx vitest run test/blueprint-membership-parity.spec.js`;
  the pinned commit must be available in local Git history (no network fetch).
- **Capture-order invariance.** When the input comes from
  `normalizeCaptureSnapshot` (which canonically sorts observations), reordering
  the raw capture produces identical membership. For a hand-built, unsorted
  array, references are still deterministic for that array, but index identity
  naturally follows that array's order.
- **Excluded/capped provenance.** `invalid_observation` covers unsupported
  method, unsafe origin and unrepresentable paths; `observation_limit` covers
  rows dropped by the 1000-observation ceiling / `maxObservations` option.
- **Snapshot-level rejection.** If the whole snapshot is refused
  (`invalid_observations`, `observation_limit`, `path_byte_limit`), no
  `membership` key is emitted at all. Validation first reports
  `invalid_observations` for unreadable input/options, or `observation_limit` for
  more than 1000 slots. For an otherwise readable snapshot whose re-derivation
  refuses the aggregate path budget, an undefined membership reports exactly
  `membership_unavailable`. Undefined evidence on a derivable snapshot, or any
  null/malformed claim, reports `malformed_membership`. A structurally valid
  supplied claim also reports `membership_unavailable` if re-derivation fails.
  Per-row rejection (including `maxSegments`) still emits membership and is not
  snapshot-level unavailability.

## Consumer API — `shared/blueprint/membership.js`

```js
import {
  MEMBERSHIP_REASON_CODES,
  selectClusterObservations,
  validateObservationMembership,
} from "./membership.js";

const outcome = validateObservationMembership(observations, membership, options);
// { valid, reasons, checked: {clusters, references}, membership: sealed|null }
```

- `options` must be the **same options** used for derivation (e.g. `minDistinct`,
  `maxObservations`); otherwise re-derivation legitimately disagrees.
- Authority is the clustering algorithm itself: validation re-derives membership
  through `inferUrlTemplates` on an inert own-data copy of the checked physical
  observation positions and known options, with membership enabled. There is no
  second regex or path rematcher. Caller `entries`, iterators, `reduce`, `filter`
  and other methods never provide authority or coverage.
- Validation is structural **and** semantic. It is not a count check: swapping
  reference sets between two equal-sized clusters is rejected.
- `reasons` is a sorted, de-duplicated list drawn only from
  `MEMBERSHIP_REASON_CODES`; no observed value, path, query key or header ever
  appears in a diagnostic.

### Reason codes

| code | meaning |
| --- | --- |
| `invalid_observations` | observations is not an array, or input/options cannot be copied as own data (including accessors or throwing/revoked proxies) |
| `invalid_observation` | a supporting reference points at a non-record observation, rather than an origin/method mismatch |
| `observation_limit` | more than 1000 observations supplied |
| `malformed_membership` | wrong shape, holes/sparse arrays, oversized strings or reference lists, duplicate cluster keys |
| `stale_observation_count` | membership was derived from a differently sized snapshot |
| `reference_budget` | claimed references exceed the 1000-reference ceiling |
| `reference_out_of_range` | non-integer, negative or beyond-snapshot reference |
| `duplicate_reference` | same reference twice inside one cluster |
| `reference_conflict` | reference claimed by two clusters, or both supporting and excluded |
| `origin_mismatch` / `method_mismatch` | referenced observation does not match the cluster's origin/method |
| `support_omitted` | authoritative support missing from the claim |
| `forged_reference` | claim contains support the algorithm does not produce |
| `cluster_missing` / `cluster_unknown` | authoritative cluster absent, or invented cluster present |
| `excluded_mismatch` | exclusion evidence rewritten, dropped or invented |
| `membership_unavailable` | bounded re-derivation refused the readable snapshot; see rejection precedence above |

### Validated capability

On success, `outcome.membership` is a **deeply frozen copy built from the
authoritative derivation**, bound to the exact `observations` array instance *and*
to the positions it checked (a frozen positional copy). It is the only object
accepted by the join helper:

```js
const supporting = selectClusterObservations(observations, outcome.membership, cluster);
// frozen array of observations in ascending reference order, or null
```

`selectClusterObservations` returns `null` for anything that was not validated by
this module, for a capability paired with a different snapshot array, for a
snapshot whose length or element identity changed after validation (replaced,
removed, appended or reordered observations), and for an unknown or non-matching
cluster key (`{origin, method, pathPattern}`). Unvalidated or forged membership
therefore cannot be turned into evidence, and mutating the caller's own membership
objects after validation cannot affect the sealed copy. Selector fields must be
own primitive strings within the same text limits; accessors, BigInt, coercion
objects and throwing/revoked proxies yield `null`, never raw exceptions. The
inert selector key is captured before checking positions, and the returned
array is constructed from exactly that checked positional copy, not later reads
of caller indices.

**Documented limitation:** the capability binds array positions and object
identity, not the internal contents of each observation. Deep mutation of an
already-validated observation object is out of scope for this primitive;
observations are expected to be treated as immutable normalized capture data.

## Bounds

Module-controlled work uses fixed ceilings: 1000 physical observation slots,
1000 claimed references, and 1000 entries per membership array. The shared
`URL_TEXT_LIMITS` enforces origins of at most 4096 characters, methods of at most
4 characters (the producer still accepts only GET/HEAD), and canonical patterns
of at most 36864 characters. Exclusion reasons are at most 64 characters.

The producer retains its 4096-character path, 32-segment and 256-character
encoded/decoded segment ceilings, and 1 MiB aggregate path-character budget
(the historical diagnostic is named `path_byte_limit`). Percent-encoding can
expand a valid path beyond 4096 characters: a 4016-character normalized path of
`!` segments becomes a 12016-character pattern. The literal canonical path
ceiling is checked before grouping, and the actual emitted pattern ceiling is
checked after dynamic substitutions. NFC expansion followed by replacing a
one- or two-character integer with `:id` can exceed the ceiling even when the
literal path fits. Every row in an over-limit partition becomes an
`invalid_observation` exclusion; no unrepresentable cluster is emitted. Static
patterns exactly at the ceiling remain accepted without reserving unused
substitution space. Over-limit origins or literal canonical paths remain
per-row `invalid_observation` exclusions.
Query-key copies are limited to 64 slots and recognized key text is checked at
64 characters before case conversion. No raw body/header data is traversed.

- Every consumed caller field, length and numeric slot is inspected once via an
  own-property descriptor. Accessors are rejected without invoking their getters;
  inherited fields do not carry authority. Null-prototype data records work.
- Membership arrays require an own data property at every index; inherited or
  sparse indices are malformed. Observation holes become invalid excluded rows,
  never inherited observations.
- Array lengths are captured and checked before copying. Oversized claims are
  refused without inspecting an index. Aggregate reference lengths are charged
  before each refs copy; a 1000-by-1000 claim stops before its second refs copy.
  `checked.references` is the charged claim total, including a rejected charge,
  not a count of valid references or getter calls.
- A whole-batch `invalid_observations` producer diagnostic uses the successfully
  captured physical observation count, including zero for an empty array with
  invalid options. The fallback count is one only when a valid array length
  cannot be captured. Snapshot failure emits no membership; diagnostic counting
  never rereads a caller length or invokes an accessor.
- Re-derivation follows cheap claim checks, except an undefined claim requires
  bounded inference to distinguish absence from genuine unavailability.

**Hostile-proxy limitation:** JavaScript provides no portable way to recognize
all proxies or preempt arbitrary code inside a descriptor trap. The module bounds
its own operations and does not dispatch caller iterators/getters/methods; a
proxy can still execute code during `getOwnPropertyDescriptor`. Thrown traps are
sanitized, but trap CPU time and proxy lies cannot be made trustworthy here.
Use inert normalized data; this is not a sandbox for arbitrary JavaScript.

## Out of scope

Endpoint roles, edges, pagination inference, confidence, blueprint emission,
runtime/UI wiring, and any change to `shared/blueprint/input.js`,
`shared/replay/*`, `roles.js` (paused PR20) or gates.
