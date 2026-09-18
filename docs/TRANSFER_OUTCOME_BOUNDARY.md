# Transfer results and recovery boundary

This slice makes the current staging-only boundary usable. It does not implement native conversion, reconciliation, Roman activation or server-owned recovery.

## Meaning of the result

- **Confirmed received:** a valid existing backend receipt matching the offered batch. Its newly-staged/no-new-row split is retained. These are not independently reconciled source-unique identities.
- **Awaiting confirmation:** one outstanding batch while this worker is actively executing.
- **Unconfirmed:** that same count after execution stops or current worker liveness is unavailable. A lost reply can follow a committed write. Do not label these records definitely missing, rejected, lost or recovered.
- **Unknown missing-record count:** unread pages, unsupported families and source completeness have no reliable denominator. Never convert skipped pages into missing client counts.
- **Native usability:** always unverified by this extension path, even when all transfer receipts were valid.

The sender adds only `pendingTransfer: { entityType, count }` to the existing local snapshot. Backpressure permits one outstanding batch; the existing single authorization refresh does not add it twice. Only a valid receipt clears it. No payload, source identity, URL or credential is added. `workerActive` is a live response field, not persisted evidence of execution.

## Coach controls

The result appears before technical intent/platform details. Check status is read-only and inspects the same recorded run; it does not poll or reconcile the backend. Copy summary includes approved category names, counts and bounded guidance, never raw errors or identity data. Copy failure remains visible.

A recorded run disables the popup's Start button so a casual retry cannot replace its result with a new timestamp intent. This is a presentation safeguard, not server fencing. The existing worker entrypoints and backend authority remain unchanged. A supported new-run/resume action depends on the owned server lifecycle contract, not clearing this guard.

## Remaining limits

The local snapshot can be lost and is not an authoritative receipt store. Current session-expiry handling clears the visible run and routes to pairing; account-bound result recovery is not solved here. Old snapshots stay readable but cannot synthesize receipt evidence. Source-account binding, staging identity collisions, atomic completion, durable lost-ACK recovery and native destination verification remain dependencies.

No installed-browser real-source migration or production acceptance is claimed by synthetic worker and popup tests.
