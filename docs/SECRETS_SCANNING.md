# Importer secret scanning (R110)

## Setup and local enforcement

Install into a private, user-owned tooling directory, never globally:

```sh
bash scripts/install-gitleaks.sh "$HOME/.local/tgp-gitleaks"
export PATH="$HOME/.local/tgp-gitleaks:$PATH"
npm ci
bash scripts/secrets-scan.sh staged
bash scripts/secrets-scan.sh history
```

The existing `prepare` script installs lefthook. Its unconditional `secrets`
command scans the index with `gitleaks protect --staged --redact=100`. It does not
silently install a scanner during a commit. Missing/wrong-version binary,
missing/invalid policy, unstaged policy edits, or scanner failure blocks the
command. A staged secret remains visible even if the working copy was cleaned.
Do not use a hook bypass as a repair: remove accidental staged material, assess
exposure, and rerun. A credential committed anywhere requires operator
containment and rotation, not deletion alone.

Exit 0 means this scan found no unexcepted matches. Exit 1 means findings or
scanner failure; exit 2 is a wrapper validation failure. Other scanner failures
are propagated unchanged. Read stderr and the redacted JSON result; never treat
a missing report or failed command as clean.

## CI scope and trust boundary

`Secrets scan` / job and expected check name **`secrets-scan`** runs on every
`pull_request`, without path filters. It checks out the exact event head SHA,
not GitHub's synthetic merge ref, with complete fetched history and
`persist-credentials: false`. `BASE_SHA` and `HEAD_SHA` are event commit hashes,
not shell-interpolated branch names. The wrapper requires both commits, the
actual head checkout, a common ancestor, nonshallow history and a nonempty range.
Missing event commits fail closed; there is no fallback to HEAD or an unrelated
local main.

The scan uses `gitleaks detect --log-opts="-p --full-history -m BASE..HEAD"`.
It inspects commits unique to the PR, including additions later removed.
`-m` exposes changes introduced only by merge resolution; `--full-history`
alone does not. Full local `history` mode uses `--all --full-history -m`.
Both paths preserve scanner command failure and redact all matched values.
The pinned scanner can otherwise swallow a Git reader's exit failure without
stderr. A temporary Git supervisor records nonzero diff/log readers, and the
wrapper blocks on that signal even if gitleaks itself returned zero. Optional
remote/config discovery failures are not treated as scan failures.

Only `contents: read` is granted; there are no write-token permissions,
repository secrets, Gitleaks license credentials, `pull_request_target`,
privileged follow-up workflow, or consumer build/install step in this job.
Fork PR code executes only within that unprivileged job. The workflow, wrapper,
tests and policy come from PR head: **this is not tamper-proof against an author
changing the entire control**. Protected review of these files and a required
check, bound to the expected GitHub Actions producer, remain essential.
The parent/operator must configure and verify those external controls after
publication; this change does not alter branch protection.

The job uploads only its redacted scan JSON for **30 days**; it never uploads
scratch canaries, Git repositories, source archives, or unredacted findings.
Absent evidence fails the artifact step. GitHub run-log retention follows the
repository/organization policy and must be verified by the operator separately.
Do not publish raw or redacted local forensic reports without sanitization.

## Pin and checksum provenance

Pinned upstream release: **Gitleaks 8.30.0**, not an unpinned action or install
pipe. The installer verifies each archive against a literal SHA-256 taken from
the upstream release checksum manifest before extracting or executing anything.
It retains the downloaded archive under the requested tooling directory.
Source URLs:

- https://github.com/gitleaks/gitleaks/releases/tag/v8.30.0
- https://github.com/gitleaks/gitleaks/releases/download/v8.30.0/gitleaks_8.30.0_checksums.txt
- https://raw.githubusercontent.com/gitleaks/gitleaks/v8.30.0/README.md

| Platform archive suffix | SHA-256 |
|---|---|
| linux_x64.tar.gz | `79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e` |
| linux_arm64.tar.gz | `b4cbbb6ddf7d1b2a603088cd03a4e3f7ce48ee7fd449b51f7de6ee2906f5fa2f` |
| darwin_x64.tar.gz | `ca221d012d247080c2f6f61f4b7a83bffa2453806b0c195c795bbe9a8c775ed5` |
| darwin_arm64.tar.gz | `b251ab2bcd4cd8ba9e56ff37698c033ebf38582b477d21ebd86586d927cf87e7` |

This establishes byte integrity against the reviewed release manifest, **not**
independent publisher attestation or proof that upstream was uncompromised.
The local wrapper checks the version and trusts the installed executable on
PATH; keep that directory owner-controlled. Only Linux x64 execution was
validated for this slice. Other listed platform archive pins are published
upstream values, not claims of local execution testing.

GitHub workflow hardening reference:
https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions

## Four reviewed synthetic exceptions, no blanket exclusions

The initial all-history scan found seven matches. Offline construction review
proved six malformed test JWTs and one header-name match. On 2026-09-17 the
parent approved the following candidate-local exceptions, contingent on real
negative controls. The policy retains all upstream defaults. Every exception
intersects one rule ID, exact anchored literal and exact anchored test path.
Hex escapes preserve exact bytes without reproducing whole token-shaped strings
in the policy diff. A changed literal or different file is not exempt.

| Construction and allowed exact files | Literal SHA-256 |
|---|---|
| Header **name**, not value, in `test/blueprint-c2a-fixture.spec.js`; synthetic `.invalid` fixture and property-name assertion | `f2a0b3f73917b62fa52617c16c12c28f7fb80cfca0ffd17b499867ccc22116ce` |
| HS256-shaped constant with only a 12-byte signature in `test/ingest-settlement.spec.js`, `test/ingest-complete-contract.spec.js`, `test/replay-truecoach-e2e.spec.js`, `test/start-import.spec.js` | `72aef19a8ffa210473265329935c586c460db7cc8f2b46a22cfc15b48ab07f9c` |
| HS256-shaped constant with only an 11-byte signature in `test/content-collector.spec.js` | `6906909c0b287ee1c7ef3dc43c2c74a866da9c21291db503a12bac36440e2e8e` |
| HS256-shaped constant with invalid base64url signature length in `test/start-import-hardening.spec.js` | `95792d3cf70a0c7a5b3425e4712363f2a64378cdf169bcc661549c7c9544ac2b` |

HS256 requires a 256-bit MAC, not these truncated or undecodable strings
(https://www.rfc-editor.org/rfc/rfc7518#section-3.2). The tests inject constants
into fake page stores and replace fetch; no credential was tested against a
service. These exceptions do not authorize accepting similarly malformed
credentials in product authentication.

No email-pattern, directory-wide, entropy, generic JWT, commit or baseline
exclusion was added. `gitleaks:allow` comments are ignored. Root
`.gitleaksignore` is refused because upstream reads it even with an explicit
alternative ignore path. Upstream source:
https://raw.githubusercontent.com/gitleaks/gitleaks/v8.30.0/cmd/root.go

## Reproduce bounded controls and operational limits

```sh
python3 test/secrets-scan-controls.py "$PWD/../secrets-controls-evidence"
```

Python 3.11+ and the real pinned scanner are required. No npm dependencies are
needed for these serial native controls. They retain isolated Git repositories
and redacted command records. Synthetic commits occur only in those fixtures,
never product history. The existing Vitest policy-hook tests remain in place;
the CI secrets job explicitly runs this additional native suite.

Rules are heuristic, not a guarantee of detecting every arbitrary high-entropy
string or encoded/binary secret. Upstream default allowlists still apply;
archive traversal is upstream's disabled default. History scope is locally
reachable fetched refs, not remote deleted refs, reflogs, LFS object contents,
submodule histories or repository-host backups. The command has a 60-second
scanner deadline and the job a ten-minute limit; failure/timeouts are blockers,
not evidence of a completed scan.

Re-review the pin and exceptions before upgrading the scanner or changing a
listed fixture; owner is Bradley Gleave. Next review: 2026-10-17. Rollback is a
reviewed revert, never a runtime skip flag. SBOM, artifact provenance, strict
typed lint, coverage and other control features are deliberately not bundled
with this R110 slice.
