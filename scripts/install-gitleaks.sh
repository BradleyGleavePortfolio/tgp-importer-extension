#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'gitleaks install: %s\n' "$1" >&2; exit 2; }
[[ $# == 1 && $1 == /* ]] || fail "provide an absolute private tooling directory"
version=8.30.0
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) platform=linux_x64; checksum=79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e ;;
  Linux/aarch64) platform=linux_arm64; checksum=b4cbbb6ddf7d1b2a603088cd03a4e3f7ce48ee7fd449b51f7de6ee2906f5fa2f ;;
  Darwin/x86_64) platform=darwin_x64; checksum=ca221d012d247080c2f6f61f4b7a83bffa2453806b0c195c795bbe9a8c775ed5 ;;
  Darwin/arm64) platform=darwin_arm64; checksum=b251ab2bcd4cd8ba9e56ff37698c033ebf38582b477d21ebd86586d927cf87e7 ;;
  *) fail "unsupported platform; use a supported Linux or macOS host" ;;
esac
umask 077
mkdir -p "$1"
destination=$(cd "$1" && pwd)
work=$(mktemp -d "$destination/download.XXXXXXXX")
asset="gitleaks_${version}_${platform}.tar.gz"
url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/${asset}"
# Verify against the reviewed pin, not a checksum fetched beside a mutable asset.
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 90 "$url" -o "$work/$asset" || fail "download failed; retry installation"
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$work/$asset")
else
  actual=$(shasum -a 256 "$work/$asset")
fi
[[ ${actual%% *} == "$checksum" ]] || fail "checksum mismatch; do not execute the download"
tar -xzf "$work/$asset" -C "$work" gitleaks
[[ $("$work/gitleaks" version) == "$version" ]] || fail "unexpected binary version"
mv "$work/gitleaks" "$destination/gitleaks"
printf 'Installed checksum-verified gitleaks %s; add %s to PATH.\n' "$version" "$destination"
