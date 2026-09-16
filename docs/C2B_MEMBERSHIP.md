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
  value) the returned object is **byte-identical to the previous behaviour**:
  `{clusters, excluded}` only, with no extra key. Existing callers are unaffected.
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
  behave exactly as before (verified by a 2400-case differential run against the
  pre-change module).
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
  `membership` key is emitted at all; validation then reports
  `membership_unavailable`.

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
  through `inferUrlTemplates(observations, {...options, membership: true})`. There
  is no second regex or path rematcher anywhere in this slice.
- Validation is structural **and** semantic. It is not a count check: swapping
  reference sets between two equal-sized clusters is rejected.
- `reasons` is a sorted, de-duplicated list drawn only from
  `MEMBERSHIP_REASON_CODES`; no observed value, path, query key or header ever
  appears in a diagnostic.

### Reason codes

| code | meaning |
| --- | --- |
| `invalid_observations` | observations argument is not an array |
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
| `membership_unavailable` | clustering refused the snapshot, so nothing is attributable |

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
objects after validation cannot affect the sealed copy.

**Documented limitation:** the capability binds array positions and object
identity, not the internal contents of each observation. Deep mutation of an
already-validated observation object is out of scope for this primitive;
observations are expected to be treated as immutable normalized capture data.

## Bounds

All work is bounded by the existing ceilings: 1000 observations, 1000 references,
1000 membership cluster entries, ≤2048-char origin/method and ≤4096-char pattern
strings, ≤64-char exclusion reasons. Anything unrepresentable fails closed with a
sanitized reason rather than a partial verdict.

Bounds are enforced **before** work is done, not after:

- a claimed `refs` array is length-checked on the caller's object before any copy
  or traversal, so an oversized or sparse claim (e.g. length 5,000,000) is refused
  without reading a single entry;
- the aggregate reference total is accumulated while materializing, so a claim of
  1000 clusters × 1000 references aborts with `reference_budget` after roughly one
  budget's worth of copying instead of a million reads;
- every claimed field is read exactly once, so an accessor cannot present one
  value to validation and another to a consumer;
- re-derivation runs only after the cheap structural checks pass.

## Out of scope

Endpoint roles, edges, pagination inference, confidence, blueprint emission,
runtime/UI wiring, and any change to `shared/blueprint/input.js`,
`shared/replay/*`, `roles.js` (paused PR20) or gates.
