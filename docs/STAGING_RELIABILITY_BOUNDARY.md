# Importer staging reliability boundary

This continuation builds on the preserved pagination and secret-scanning candidates, not a replacement replay engine. It improves the current transfer boundary; it does not implement or certify the finished migration journey.

## Runtime behavior

- `content/main.js` is a classic manifest content script. Its exact shipping bytes are exercised by the collector and browser-entrypoint harnesses, without module rewriting or production test exports.
- Source storage is read lazily on an authorized message. Denied storage yields no credential, and storage errors are not exposed. A JWT-shaped value remains only a credential candidate: this is not verified source principal/workspace binding.
- A successful ingest HTTP status alone is insufficient. The extension requires a JSON acknowledgement with safe-integer `received` equal to the submitted batch length and `0 <= deduped <= received`.
- Acknowledgement consumption shares the existing finite request deadline and has a 4,096-byte limit. Missing, malformed, oversized or inconsistent receipts fail closed without exposing their content.
- Per-family staging counters distinguish accepted envelope entries, newly inserted staging rows and entries that produced no new row. They do not prove source uniqueness, correct deduplication, native records or migration completion.
- A later failed batch retains the earlier acknowledged counts for failed settlement. Unknown/unacknowledged writes are not counted as successful, even though a lost response may mean the server persisted data.
- Popup and operating-system notification copy describe staging, not complete business migration. Older snapshots remain readable without inventing new receipt evidence.

## Compatibility and unresolved dependencies

The accepted acknowledgement matches the existing backend `ScoutIngestResult` contract. The backend's legacy `terminal_status: success` and the extension's `ingest_succeeded` identifier remain transport-level compatibility values; they are not authoritative native-migration outcomes.

Backend identity widening, atomicity, authoritative reconciliation, and server-side completion notifications are separate dependencies. In particular, `deduped` does not prove an identity collision was legitimate. Do not present it as "already present and verified."

The Roman-led journey still requires durable server-owned setup/run intent, idempotent setup recovery, an account-bound desktop handoff, one accepted Start with its immutable deadline, cross-device Stop/disconnect fencing, source-principal continuity, native destination writers, and verified reconciliation. The planned C1 contract precedes the mobile consumer. This change does not activate flags or authorize release.

## Verification boundaries

Tests cover manifest/classic-script execution, denied and changing storage, real streamed acknowledgement bodies, malformed receipt counts, byte/time bounds, refreshed-auth retries, retained earlier counts, and localized popup/notification behavior. The browser entrypoint tests use a JavaScript classic-script runtime; they are not a real Chrome installation, live-source authorization, two-platform acceptance or a production import.
