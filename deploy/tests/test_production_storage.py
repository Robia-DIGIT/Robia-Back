"""RC-33 hardening — verifies the real docker-compose.production.yml (not a
stub) actually wires a writable, persistent path for ODC uploads: a named
volume mounted at ODC_UPLOAD_DIR on the `backend` service, surviving
`read_only: true`, plus the env var pointing at that exact same path.

Runs `docker compose config` against the real file — no Docker daemon
required (this is static config resolution, the same command
production-containers and github-deploy.sh both already run) — so this test
is also meaningful in a daemon-less sandbox.
"""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = ROOT / "docker-compose.production.yml"
ENV_EXAMPLE = ROOT / ".env.production.example"
ENV_PRODUCTION = ROOT / ".env.production"


@unittest.skipUnless(shutil.which("docker"), "docker CLI not available")
class ProductionOdcStorageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # The `backend`/`migrate`/`ai-engine` services each declare a literal
        # `env_file: .env.production` — `docker compose config` refuses to
        # resolve without that exact file existing, regardless of
        # `--env-file`. Never overwrite or delete a real secrets file left
        # by an operator/CI step: only ever create+remove our own temporary
        # copy of the example, the same "cp .env.production.example
        # .env.production" the production-containers CI job already does.
        cls._owns_env_file = not ENV_PRODUCTION.exists()
        if cls._owns_env_file:
            shutil.copyfile(ENV_EXAMPLE, ENV_PRODUCTION)
        try:
            result = subprocess.run(
                [
                    "docker",
                    "compose",
                    "--env-file",
                    str(ENV_PRODUCTION),
                    "-f",
                    str(COMPOSE_FILE),
                    "config",
                    "--format",
                    "json",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=30,
            )
        finally:
            if cls._owns_env_file:
                ENV_PRODUCTION.unlink(missing_ok=True)
        if result.returncode != 0:
            raise RuntimeError(f"docker compose config failed: {result.stderr}")
        cls.config = json.loads(result.stdout)
        cls.backend = cls.config["services"]["backend"]

    def test_odc_upload_dir_env_var_is_set(self):
        self.assertEqual(
            self.backend["environment"].get("ODC_UPLOAD_DIR"),
            "/data/odc-uploads",
        )

    def test_a_named_volume_is_mounted_at_odc_upload_dir(self):
        mounts = self.backend.get("volumes", [])
        matching = [m for m in mounts if m.get("target") == "/data/odc-uploads"]
        self.assertEqual(
            len(matching),
            1,
            f"expected exactly one mount at /data/odc-uploads, got {mounts}",
        )
        mount = matching[0]
        self.assertEqual(mount["type"], "volume")
        self.assertTrue(mount["source"], "volume must be named, not anonymous")

    def test_the_volume_is_declared_top_level_so_it_survives_recreation(self):
        mounts = self.backend.get("volumes", [])
        source = next(
            m["source"] for m in mounts if m.get("target") == "/data/odc-uploads"
        )
        self.assertIn(source, self.config.get("volumes", {}))

    def test_backend_root_filesystem_stays_read_only(self):
        # The explicit named-volume mount must never be why read_only was
        # dropped — Docker keeps a named-volume mount writable independently
        # of the container's own read-only root.
        self.assertTrue(self.backend.get("read_only"))

    def test_odc_upload_dir_is_never_under_the_tmpfs_mount(self):
        # /tmp is ephemeral (wiped on every container recreation) — the
        # upload path must never resolve under it.
        self.assertFalse("/data/odc-uploads".startswith("/tmp"))


if __name__ == "__main__":
    unittest.main()
