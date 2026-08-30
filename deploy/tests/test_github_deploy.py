"""Exercise the dispatcher with real temporary Git repos and fake Docker/HTTP.

No SSH connection, production path, real Docker daemon, or external URL is used.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "github-deploy.sh"
STUB = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps([name, *args]) + "\n")
if name == "docker":
    if args[0] == "compose":
        if "config" in args and "json" in args:
            print(json.dumps({"services": {"app": {"ports": [80] if os.getenv("FAKE_PORTS") else []}}}))
        elif "build" in args:
            sys.exit(int(os.getenv("FAKE_BUILD_EXIT", "0")))
        elif "up" in args:
            sys.exit(int(os.getenv("FAKE_UP_EXIT", "0")))
        elif "ps" in args:
            if os.getenv("FAKE_MISSING") != args[-1]:
                print(args[-1] + "-id")
    elif args[0] == "inspect":
        if "ExitCode" in args[2]:
            print("exited " + os.getenv("FAKE_MIGRATION_EXIT", "0"))
        else:
            counter = Path(os.environ["FAKE_LOG"] + ".health-count")
            count = int(counter.read_text()) if counter.exists() else 0
            counter.write_text(str(count + 1))
            print("running starting" if count < int(os.getenv("FAKE_HEALTH_DELAY", "0")) else os.getenv("FAKE_HEALTH", "running healthy"))
elif name == "curl":
    print(os.getenv("FAKE_HTTP", "200"), end="")
elif name == "flock":
    sys.exit(int(os.getenv("FAKE_LOCK_EXIT", "0")))
'''


class DeploymentTests(unittest.TestCase):
    def git(self, path, *args):
        return subprocess.check_output(["git", "-C", str(path), *args], stderr=subprocess.DEVNULL, text=True).strip()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="robia-deploy-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "calls.jsonl"
        for name in ("docker", "curl", "sleep", "flock"):
            stub = self.bin / name
            stub.write_text(STUB)
            stub.chmod(0o700)
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"], FAKE_LOG=str(self.log))
        self.srv = self.root / "srv"
        (self.srv / "scripts").mkdir(parents=True)
        self.backup = self.srv / "scripts/backup-supabase.sh"
        self.backup.write_text('#!/bin/sh\nprintf \'["backup"]\\n\' >> "$FAKE_LOG"\nexit "${FAKE_BACKUP_EXIT:-0}"\n')
        self.runner = self.root / "dispatcher.sh"
        self.runner.write_text(SCRIPT.read_text().replace("/srv/robia", str(self.srv)))
        self.source = self.root / "source"
        self.source.mkdir()
        self.git(self.source, "init", "-b", "main")
        self.git(self.source, "config", "user.name", "Deployment Test")
        self.git(self.source, "config", "user.email", "test@example.invalid")
        (self.source / "version").write_text("base\n")
        (self.source / ".gitignore").write_text(".env.production\n")
        self.git(self.source, "add", ".")
        self.git(self.source, "commit", "-m", "base")
        self.base = self.git(self.source, "rev-parse", "HEAD")
        for directory in ("robia-back", "robia-monorepo"):
            self.git(self.srv, "clone", str(self.source), directory)
        (self.source / "version").write_text("tested release\n")
        self.git(self.source, "commit", "-am", "tested release")
        self.sha = self.git(self.source, "rev-parse", "HEAD")

    def run_deploy(self, target="backend", command=None, **env):
        command = command if command is not None else f"deploy-{target} {self.sha}"
        return subprocess.run(["sh", str(self.runner)], env=dict(self.env, SSH_ORIGINAL_COMMAND=command, **env), text=True, capture_output=True, timeout=30)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def assert_no_up(self):
        self.assertFalse(any("up" in call for call in self.calls()), self.calls())

    def test_backend_success_exact_sha_backup_health_and_record(self):
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(self.srv / "robia-back", "rev-parse", "HEAD"), self.sha)
        calls = self.calls()
        backup = calls.index(["backup"])
        self.assertLess(backup, next(i for i, c in enumerate(calls) if "up" in c))
        self.assertIn("DEPLOY_SUCCESS=backend", result.stdout)
        self.assertEqual((self.srv / "deployments/backend.last-successful-sha").read_text().strip(), self.sha)

    def test_frontend_success_no_database_backup(self):
        result = self.run_deploy(target="frontend")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(["backup"], self.calls())
        self.assertEqual(len([c for c in self.calls() if c[0] == "curl"]), 3)

    def test_invalid_commands_never_reach_git_or_docker(self):
        for command in ("invalid", "", "deploy-backend", "deploy-frontend main", "deploy-backend " + self.sha + ";id", "deploy-backend " + self.sha + " extra", "deploy-backend " + self.sha.upper(), "deploy-frontend " + "f" * 39):
            with self.subTest(command=command):
                result = self.run_deploy(command=command)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls(), [])

    def test_stale_commit_is_not_deployed(self):
        result = self.run_deploy(command="deploy-backend " + self.base)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Stale", result.stderr)
        self.assert_no_up()
        self.assertEqual(self.git(self.srv / "robia-back", "rev-parse", "HEAD"), self.base)

    def test_dirty_checkout_is_preserved(self):
        version = self.srv / "robia-back/version"
        version.write_text("operator changes\n")
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(version.read_text(), "operator changes\n")
        self.assert_no_up()

    def test_untracked_files_are_not_overwritten(self):
        (self.srv / "robia-back/operator-note").write_text("keep")
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_up()

    def test_ignored_env_is_preserved(self):
        envfile = self.srv / "robia-back/.env.production"
        envfile.write_text("TEST_SECRET=preserve\n")
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(envfile.read_text(), "TEST_SECRET=preserve\n")
        self.assertNotIn("TEST_SECRET", result.stdout + result.stderr)

    def test_non_main_branch_is_refused(self):
        self.git(self.srv / "robia-back", "switch", "-c", "operator-branch")
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_up()

    def test_local_divergence_is_refused(self):
        repo = self.srv / "robia-back"
        self.git(repo, "config", "user.name", "Operator")
        self.git(repo, "config", "user.email", "operator@example.invalid")
        (repo / "version").write_text("local commit\n")
        self.git(repo, "commit", "-am", "local commit")
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("diverged", result.stderr)
        self.assert_no_up()

    def test_lock_timeout_stops_before_checkout(self):
        result = self.run_deploy(FAKE_LOCK_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_up()
        self.assertEqual(self.git(self.srv / "robia-back", "rev-parse", "HEAD"), self.base)

    def test_published_ports_are_refused(self):
        result = self.run_deploy(FAKE_PORTS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_up()

    def test_build_failure_keeps_running_containers(self):
        result = self.run_deploy(FAKE_BUILD_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_up()

    def test_backup_failure_keeps_running_containers(self):
        result = self.run_deploy(FAKE_BACKUP_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_up()

    def test_missing_backup_keeps_running_containers(self):
        self.backup.unlink()
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_up()

    def test_compose_start_failure_is_reported(self):
        result = self.run_deploy(FAKE_UP_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.srv / "deployments/backend.last-successful-sha").exists())

    def test_migration_failure_is_reported(self):
        result = self.run_deploy(FAKE_MIGRATION_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("DEPLOY_SUCCESS", result.stdout)

    def test_health_failure_is_reported(self):
        result = self.run_deploy(FAKE_HEALTH="exited unhealthy")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("DEPLOY_SUCCESS", result.stdout)

    def test_health_starting_is_retried(self):
        result = self.run_deploy(FAKE_HEALTH_DELAY="2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreaterEqual(len([c for c in self.calls() if c[0] == "sleep"]), 2)

    def test_unhealthy_timeout_is_reported(self):
        result = self.run_deploy(FAKE_HEALTH="running unhealthy")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Health timeout", result.stderr)
        self.assertEqual(len([c for c in self.calls() if c[0] == "sleep"]), 60)

    def test_missing_container_is_reported(self):
        result = self.run_deploy(FAKE_MISSING="backend")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing container", result.stderr)

    def test_https_redirect_is_not_success(self):
        result = self.run_deploy(FAKE_HTTP="302")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("HTTPS check failed", result.stderr)


if __name__ == "__main__":
    unittest.main()
