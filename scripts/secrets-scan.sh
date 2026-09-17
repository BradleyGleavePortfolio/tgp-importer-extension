#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'secrets-scan: %s\n' "$1" >&2; exit 2; }
[[ $# -gt 0 ]] || fail "use staged, history, or pr BASE_SHA HEAD_SHA"
command -v gitleaks >/dev/null || fail "gitleaks unavailable; run scripts/install-gitleaks.sh and add its directory to PATH"
[[ $(gitleaks version) == "8.30.0" ]] || fail "gitleaks 8.30.0 required; reinstall the pinned release"
root=$(git rev-parse --show-toplevel) || fail "not a Git repository"
cd "$root"
[[ -f .gitleaks.toml ]] || fail "missing .gitleaks.toml; restore reviewed scanner policy"
# Upstream always reads source/.gitleaksignore, even with an explicit ignore path.
[[ ! -e .gitleaksignore && ! -L .gitleaksignore ]] || fail "fingerprint suppressions are forbidden; remove .gitleaksignore and review exact policy"
case "$1" in
  staged)
    [[ $# == 1 ]] || fail "staged accepts no extra options"
    git diff --quiet -- .gitleaks.toml || fail "scanner policy has unstaged edits; stage the reviewed policy first"
    git diff --cached --name-only >/dev/null || fail "cannot read staged changes"
    args=(protect --staged --source .)
    ;;
  history)
    [[ $# == 1 ]] || fail "history accepts no extra options"
    [[ $(git rev-parse --is-shallow-repository) == false ]] || fail "shallow history; fetch complete history before scanning"
    git rev-list --all >/dev/null || fail "cannot traverse history"
    args=(git --log-opts="--all --full-history -m" .)
    ;;
  pr)
    [[ $# == 3 && $2 =~ ^[0-9a-f]{40}$ && $3 =~ ^[0-9a-f]{40}$ ]] || fail "PR scan requires exact base and head commit SHAs"
    [[ $(git rev-parse --is-shallow-repository) == false ]] || fail "shallow history; fetch complete PR and base history"
    git cat-file -e "$2^{commit}" && git cat-file -e "$3^{commit}" || fail "missing PR base or head; fetch exact event commits"
    [[ $(git rev-parse HEAD) == "$3" ]] || fail "checkout is not the event PR head"
    git merge-base "$2" "$3" >/dev/null || fail "unrelated PR base and head"
    count=$(git rev-list --count "$2..$3") || fail "cannot traverse PR range"
    [[ $count -gt 0 ]] || fail "empty PR commit range; verify event SHAs"
    args=(detect --source . --log-opts="-p --full-history -m $2..$3")
    ;;
  *) fail "unknown scan mode; use staged, history, or pr" ;;
esac
# Upstream can return zero when its Git reader exits nonzero without stderr.
# Supervise only diff/log readers; optional remote/config probes may legitimately fail.
git_path=$(command -v git)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
{
  printf '#!/usr/bin/env bash\nreal_git=%q\nfailure=%q\n' "$git_path" "$work/reader-failed"
  cat <<'SHIM'
set +e
"$real_git" "$@"
status=$?
if [[ $status != 0 ]]; then
  case "$1:${3:-}" in
    -C:diff|-C:log|diff:*|log:*) printf '%s\n' "$status" >> "$failure" ;;
  esac
fi
exit "$status"
SHIM
} > "$work/git"
chmod 700 "$work/git"
status=0
PATH="$work:$PATH" gitleaks "${args[@]}" --config .gitleaks.toml --redact=100 \
  --ignore-gitleaks-allow --gitleaks-ignore-path=/dev/null --exit-code=1 \
  --timeout=60 --no-banner --no-color --log-level=error --report-format=json --report-path=- || status=$?
[[ ! -e "$work/reader-failed" ]] || fail "Git diff/log reader failed; scan incomplete, repair repository/tooling and retry"
exit "$status"
