"""Real, offline gitleaks controls. Never print matched material or remove evidence."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest

REPO = Path(__file__).resolve().parents[1]
EVIDENCE = Path(sys.argv.pop(1)).resolve()
EVIDENCE.mkdir(parents=True, exist_ok=True)
SCANNER = shutil.which("gitleaks")
WRAPPER = REPO / "scripts/secrets-scan.sh"
INSTALLER = REPO / "scripts/install-gitleaks.sh"
# This value is generated only inside isolated fixtures, never in product history.
CANARY = "ghp_" + ("A1b2C3d4E5f6" * 3)
RESULTS = []


class ScannerControls(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(SCANNER, "Install the pinned scanner before tests")
        self.root = Path(tempfile.mkdtemp(prefix=self._testMethodName + "-", dir=EVIDENCE))
        self.env = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.root),
            "GOMAXPROCS": "1",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
        }
        self.git("init", "-q", "-b", "main")
        self.put(".gitleaks.toml", (REPO / ".gitleaks.toml").read_text())
        self.put("readme.txt", "ordinary project text\n")
        self.commit("clean base")
        self.base = self.git("rev-parse", "HEAD").stdout.strip()

    def put(self, path, content):
        destination = self.root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content)
        return destination

    def git(self, *args):
        result = subprocess.run(
            ["git", *args], cwd=self.root, env=self.env,
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, "fixture Git command failed")
        return result

    def commit(self, title):
        self.git("add", ".")
        self.git(
            "-c", "user.name=Bradley Gleave",
            "-c", "user.email=bradley@bradleytgpcoaching.com",
            "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", title,
        )

    def run_scan(self, *args, env=None, expected=0):
        result = subprocess.run(
            ["bash", str(WRAPPER), *args], cwd=self.root, env=env or self.env,
            capture_output=True, text=True, timeout=75,
        )
        output = result.stdout + result.stderr
        # Do not pass raw output to assert messages: they are public test logs.
        self.assertFalse(CANARY in output, "scanner output was not redacted")
        RESULTS.append({
            "test": self._testMethodName, "mode": list(args),
            "exit": result.returncode, "expected": expected,
            "stdout_file": str(self.root / f"scan-{len(RESULTS)}.json"),
        })
        (self.root / f"scan-{len(RESULTS)}.json").write_text(result.stdout)
        (self.root / f"scan-{len(RESULTS)}.stderr").write_text(result.stderr)
        self.assertEqual(result.returncode, expected, "unexpected scanner exit")
        return result

    def stage_canary(self, path="credentials.txt", suffix=""):
        self.put(path, f'access_token = "{CANARY}"{suffix}\n')
        self.git("add", path)

    def assert_finding(self, result, path):
        findings = json.loads(result.stdout)
        self.assertGreater(len(findings), 0)
        self.assertIn(path, [item["File"] for item in findings])
        self.assertTrue(all(item["Secret"] == "REDACTED" for item in findings))

    def private_path(self, scanner_script=None):
        directory = self.root / "path"
        directory.mkdir()
        for name in ["bash", "git", "dirname", "mktemp", "cat", "chmod", "rm"]:
            executable = shutil.which(name)
            self.assertIsNotNone(executable)
            (directory / name).symlink_to(executable)
        if scanner_script is not None:
            executable = self.put("path/gitleaks", scanner_script)
            executable.chmod(0o700)
        return {**self.env, "PATH": str(directory)}

    def test_clean_staged_diff(self):
        self.put("readme.txt", "ordinary changed text\n")
        self.git("add", "readme.txt")
        result = self.run_scan("staged")
        self.assertEqual(json.loads(result.stdout), [])

    def test_empty_staged_diff(self):
        result = self.run_scan("staged")
        self.assertEqual(json.loads(result.stdout), [])

    def test_staged_canary_blocks(self):
        self.stage_canary()
        result = self.run_scan("staged", expected=1)
        self.assert_finding(result, "credentials.txt")

    def test_unstaged_canary_is_not_the_index(self):
        self.put("unstaged.txt", CANARY + "\n")
        result = self.run_scan("staged")
        self.assertEqual(json.loads(result.stdout), [])

    def test_worktree_removal_cannot_hide_staged_canary(self):
        self.stage_canary()
        self.put("credentials.txt", "no credential in the working copy\n")
        result = self.run_scan("staged", expected=1)
        self.assert_finding(result, "credentials.txt")

    def test_clean_pr_history(self):
        self.put("readme.txt", "one clean PR commit\n")
        self.commit("clean change")
        head = self.git("rev-parse", "HEAD").stdout.strip()
        result = self.run_scan("pr", self.base, head)
        self.assertEqual(json.loads(result.stdout), [])

    def test_removed_secret_stays_in_pr_and_all_history(self):
        self.stage_canary()
        self.commit("synthetic positive control")
        introduced = self.git("rev-parse", "HEAD").stdout.strip()
        self.put("credentials.txt", "removed before PR head\n")
        self.commit("remove synthetic positive control")
        head = self.git("rev-parse", "HEAD").stdout.strip()
        result = self.run_scan("pr", self.base, head, expected=1)
        self.assert_finding(result, "credentials.txt")
        self.assertIn(introduced, [item["Commit"] for item in json.loads(result.stdout)])
        history = self.run_scan("history", expected=1)
        self.assert_finding(history, "credentials.txt")
        self.assertEqual(json.loads(self.run_scan("staged").stdout), [])

    def test_side_branch_removed_secret_stays_in_merge_history(self):
        self.git("checkout", "-q", "-b", "side")
        self.stage_canary()
        self.commit("side synthetic positive control")
        self.put("credentials.txt", "removed on side branch\n")
        self.commit("remove side positive control")
        self.git("checkout", "-q", "main")
        self.git(
            "-c", "user.name=Bradley Gleave",
            "-c", "user.email=bradley@bradleytgpcoaching.com",
            "merge", "--no-ff", "-m", "merge side", "side",
        )
        head = self.git("rev-parse", "HEAD").stdout.strip()
        result = self.run_scan("pr", self.base, head, expected=1)
        self.assert_finding(result, "credentials.txt")

    def test_merge_resolution_secret_absent_from_both_parents(self):
        self.git("checkout", "-q", "-b", "side")
        self.put("side.txt", "clean side change\n")
        self.commit("clean side")
        self.git("checkout", "-q", "main")
        self.put("main.txt", "clean main change\n")
        self.commit("clean main")
        self.git(
            "-c", "user.name=Bradley Gleave",
            "-c", "user.email=bradley@bradleytgpcoaching.com",
            "merge", "--no-ff", "--no-commit", "side",
        )
        self.stage_canary()
        self.commit("merge resolution synthetic positive control")
        head = self.git("rev-parse", "HEAD").stdout.strip()
        result = self.run_scan("pr", self.base, head, expected=1)
        self.assert_finding(result, "credentials.txt")
        self.assertIn(head, [item["Commit"] for item in json.loads(result.stdout)])
        history = self.run_scan("history", expected=1)
        self.assert_finding(history, "credentials.txt")

    def test_real_scanner_git_reader_failure_is_not_clean(self):
        directory = self.root / "reader-path"
        directory.mkdir()
        real_git = shutil.which("git")
        self.assertIsNotNone(real_git)
        fake_git = self.put(
            "reader-path/git",
            '#!/bin/bash\n'
            'if [[ " $* " == *" diff "* && " $* " != *" --name-only "* '
            '&& " $* " != *" --quiet "* ]]; then exit 19; fi\n'
            f'exec "{real_git}" "$@"\n',
        )
        fake_git.chmod(0o700)
        self.stage_canary()
        result = self.run_scan(
            "staged", env={**self.env, "PATH": str(directory) + ":" + self.env["PATH"]},
            expected=2,
        )
        self.assertIn("Git diff/log reader failed", result.stderr)

    def test_real_scanner_git_log_failure_is_not_clean(self):
        directory = self.root / "log-path"
        directory.mkdir()
        real_git = shutil.which("git")
        self.assertIsNotNone(real_git)
        fake_git = self.put(
            "log-path/git",
            '#!/bin/bash\n'
            'if [[ " $* " == *" log "* ]]; then exit 23; fi\n'
            f'exec "{real_git}" "$@"\n',
        )
        fake_git.chmod(0o700)
        self.put("readme.txt", "clean new revision\n")
        self.commit("clean head for reader failure")
        head = self.git("rev-parse", "HEAD").stdout.strip()
        result = self.run_scan(
            "pr", self.base, head,
            env={**self.env, "PATH": str(directory) + ":" + self.env["PATH"]},
            expected=2,
        )
        self.assertIn("Git diff/log reader failed", result.stderr)

    def test_ignore_comment_does_not_exempt_canary(self):
        self.stage_canary(suffix=" # gitleaks:allow")
        result = self.run_scan("staged", expected=1)
        self.assert_finding(result, "credentials.txt")

    def test_fingerprint_file_does_not_exempt_canary(self):
        self.stage_canary()
        initial = self.run_scan("staged", expected=1)
        findings = json.loads(initial.stdout)
        self.put(".gitleaksignore", "\n".join(item["Fingerprint"] for item in findings))
        self.git("add", ".gitleaksignore")
        result = self.run_scan("staged", expected=2)
        self.assertIn("fingerprint suppressions are forbidden", result.stderr)

    def test_test_directory_is_scanned(self):
        self.stage_canary("test/ordinary.spec.js")
        result = self.run_scan("staged", expected=1)
        self.assert_finding(result, "test/ordinary.spec.js")

    def approved_literals(self):
        files = [
            "blueprint-c2a-fixture", "ingest-settlement", "ingest-complete-contract",
            "replay-truecoach-e2e", "start-import", "content-collector",
            "start-import-hardening",
        ]
        values = {}
        for name in files:
            path = "test/" + name + ".spec.js"
            text = (REPO / path).read_text()
            match = re.search(r'const (?:credentialName|SRC_JWT|JWT) = "([^"]+)"', text)
            self.assertIsNotNone(match)
            values[path] = match[1]
        self.assertEqual(len(values), 7)
        return values

    def test_approved_exact_literals_in_exact_paths_are_clean(self):
        for path, value in self.approved_literals().items():
            variable = "credentialName" if "blueprint-c2a" in path else "SRC_JWT"
            self.put(path, f'const {variable} = "{value}";\n')
            self.git("add", path)
        result = self.run_scan("staged")
        self.assertEqual(json.loads(result.stdout), [])

    def test_every_modified_literal_in_same_path_is_detected(self):
        values = self.approved_literals()
        for path, value in values.items():
            changed = value[:-1] + ("3" if "blueprint-c2a" in path else "A")
            variable = "credentialName" if "blueprint-c2a" in path else "SRC_JWT"
            self.put(path, f'const {variable} = "{changed}";\n')
            self.git("add", path)
        result = self.run_scan("staged", expected=1)
        files = {item["File"] for item in json.loads(result.stdout)}
        self.assertEqual(files, set(values))

    def test_every_exact_literal_outside_approved_paths_is_detected(self):
        paths = set()
        for path, value in self.approved_literals().items():
            outside = "outside/" + path
            paths.add(outside)
            variable = "credentialName" if "blueprint-c2a" in path else "SRC_JWT"
            self.put(outside, f'const {variable} = "{value}";\n')
            self.git("add", outside)
        result = self.run_scan("staged", expected=1)
        files = {item["File"] for item in json.loads(result.stdout)}
        self.assertEqual(files, paths)

    def test_other_secret_types_in_all_approved_paths_are_detected(self):
        values = self.approved_literals()
        for path in values:
            self.stage_canary(path)
        result = self.run_scan("staged", expected=1)
        files = {item["File"] for item in json.loads(result.stdout)}
        self.assertEqual(files, set(values))

    def test_policy_keeps_all_default_rules_and_four_exact_intersections(self):
        config = tomllib.loads((REPO / ".gitleaks.toml").read_text())
        self.assertEqual(config["extend"], {"useDefault": True})
        self.assertEqual(len(config["allowlists"]), 4)
        for item in config["allowlists"]:
            self.assertEqual(item["condition"], "AND")
            self.assertEqual(item["regexTarget"], "secret")
            self.assertEqual(len(item["targetRules"]), 1)
            self.assertIn(item["targetRules"][0], ["jwt", "generic-api-key"])
            self.assertEqual(set(item), {
                "description", "targetRules", "condition", "paths", "regexTarget", "regexes",
            })
            self.assertTrue(all(path.startswith("^test/") and path.endswith("$") for path in item["paths"]))
            self.assertTrue(all(pattern.startswith("^") and pattern.endswith("$") for pattern in item["regexes"]))

    def test_operator_email_does_not_exempt_canary(self):
        self.stage_canary(suffix=" # bradley@bradleytgpcoaching.com")
        result = self.run_scan("staged", expected=1)
        self.assert_finding(result, "credentials.txt")

    def test_environment_config_cannot_override_explicit_policy(self):
        self.stage_canary()
        env = {**self.env, "GITLEAKS_CONFIG_TOML": 'title = "empty policy"'}
        result = self.run_scan("staged", env=env, expected=1)
        self.assert_finding(result, "credentials.txt")

    def test_missing_binary_fails_closed(self):
        result = self.run_scan("staged", env=self.private_path(), expected=2)
        self.assertIn("gitleaks unavailable", result.stderr)

    def test_wrong_version_fails_closed(self):
        env = self.private_path("#!/bin/bash\nprintf '0.0.0\\n'\n")
        result = self.run_scan("staged", env=env, expected=2)
        self.assertIn("8.30.0 required", result.stderr)

    def test_scanner_failure_is_propagated(self):
        env = self.private_path(
            '#!/bin/bash\nif [[ $1 == version ]]; then echo 8.30.0; else exit 17; fi\n'
        )
        result = self.run_scan("staged", env=env, expected=17)
        self.assertEqual(result.stdout, "")

    def test_missing_config_fails_closed(self):
        (self.root / ".gitleaks.toml").rename(self.root / "retained-policy.toml")
        result = self.run_scan("staged", expected=2)
        self.assertIn("missing .gitleaks.toml", result.stderr)

    def test_invalid_config_is_scanner_failure(self):
        self.put(".gitleaks.toml", "[invalid TOML")
        self.git("add", ".gitleaks.toml")
        self.run_scan("staged", expected=1)
        self.assertTrue((self.root / ".gitleaks.toml").is_file())

    def test_unstaged_policy_cannot_change_staged_scan(self):
        self.put(".gitleaks.toml", 'title = "unreviewed change"\n')
        self.stage_canary()
        result = self.run_scan("staged", expected=2)
        self.assertIn("policy has unstaged edits", result.stderr)

    def test_missing_base_fails_closed(self):
        result = self.run_scan("pr", "0" * 40, self.base, expected=2)
        self.assertIn("missing PR base or head", result.stderr)

    def test_missing_head_fails_closed(self):
        result = self.run_scan("pr", self.base, "0" * 40, expected=2)
        self.assertIn("missing PR base or head", result.stderr)

    def test_non_sha_range_cannot_inject_options(self):
        result = self.run_scan("pr", "--all", self.base, expected=2)
        self.assertIn("exact base and head", result.stderr)

    def test_wrong_checkout_fails_closed(self):
        self.put("readme.txt", "new revision\n")
        self.commit("head mismatch")
        result = self.run_scan("pr", self.base, self.base, expected=2)
        self.assertIn("not the event PR head", result.stderr)

    def test_empty_pr_range_fails_closed(self):
        result = self.run_scan("pr", self.base, self.base, expected=2)
        self.assertIn("empty PR commit range", result.stderr)

    def test_shallow_clone_fails_closed(self):
        clone = self.root / "shallow"
        self.git("clone", "-q", "--depth=1", self.root.as_uri(), str(clone))
        original = self.root
        self.root = clone
        result = self.run_scan("pr", self.base, self.base, expected=2)
        self.assertIn("shallow history", result.stderr)
        history = self.run_scan("history", expected=2)
        self.assertIn("shallow history", history.stderr)
        self.root = original

    def test_unknown_mode_fails_closed(self):
        result = self.run_scan("incorrect", expected=2)
        self.assertIn("unknown scan mode", result.stderr)

    def test_extra_staged_options_are_rejected(self):
        result = self.run_scan("staged", "--exit-code=0", expected=2)
        self.assertIn("no extra options", result.stderr)

    def run_install_failure(self, curl_script, expected_message):
        directory = self.root / "install-path"
        directory.mkdir()
        for name in ["bash", "uname", "mkdir", "mktemp", "sha256sum"]:
            executable = shutil.which(name)
            self.assertIsNotNone(executable)
            (directory / name).symlink_to(executable)
        curl = self.put("install-path/curl", curl_script)
        curl.chmod(0o700)
        destination = self.root / "download"
        result = subprocess.run(
            ["bash", str(INSTALLER), str(destination)],
            cwd=self.root, env={**self.env, "PATH": str(directory)},
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn(expected_message, result.stderr)
        self.assertFalse((destination / "gitleaks").exists())
        RESULTS.append({
            "test": self._testMethodName, "exit": result.returncode,
            "expected": 2, "reason": expected_message,
        })

    def test_download_failure_cannot_install(self):
        self.run_install_failure("#!/bin/bash\nexit 22\n", "download failed")

    def test_checksum_failure_cannot_execute_or_install(self):
        self.run_install_failure(
            '#!/bin/bash\nwhile [[ $1 != -o ]]; do shift; done\n'
            'printf "corrupt archive" > "$2"\n',
            "checksum mismatch",
        )


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        (EVIDENCE / "control-results.json").write_text(json.dumps(RESULTS, indent=2) + "\n")
