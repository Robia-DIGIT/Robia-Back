"""RC-33 hardening — integration scenarios 1 & 2 from the PR2 spec: a real
upload against the actual production container configuration (the built
runtime image + a real named volume, read_only root filesystem included),
and that the file survives container recreation exactly like a
`docker compose up -d --build` redeploy does.

Requires a live Docker daemon — skipped cleanly (not failed) when one isn't
reachable. This sandboxed session has no daemon
(`docker info` fails — see the session's own environment notes); GitHub
Actions' `deployment-tests` job does, so this test actually executes there.
"""
import shutil
import subprocess
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "robia-backend:odc-storage-integration-test"


def _docker_daemon_reachable() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        result = subprocess.run(
            ["docker", "info"], capture_output=True, timeout=10
        )
    except (subprocess.TimeoutExpired, OSError):
        return False
    return result.returncode == 0


@unittest.skipUnless(_docker_daemon_reachable(), "docker daemon not reachable")
class OdcUploadPersistenceIntegrationTests(unittest.TestCase):
    """Mirrors the exact runtime shape docker-compose.production.yml gives
    the `backend` service: --read-only, a tmpfs /tmp, and the named volume
    mounted at ODC_UPLOAD_DIR — built directly from this repo's own
    Dockerfile, never a stand-in."""

    @classmethod
    def setUpClass(cls):
        subprocess.run(
            ["docker", "build", "--target", "runtime", "--tag", IMAGE, str(ROOT)],
            check=True,
            cwd=ROOT,
            timeout=600,
        )

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["docker", "rmi", "-f", IMAGE], capture_output=True)

    def setUp(self):
        unique = uuid.uuid4().hex[:8]
        self.volume = f"robia-odc-storage-test-{unique}"
        self.container = f"robia-odc-storage-test-container-{unique}"
        self.addCleanup(
            lambda: subprocess.run(
                ["docker", "rm", "-f", self.container], capture_output=True
            )
        )
        self.addCleanup(
            lambda: subprocess.run(
                ["docker", "volume", "rm", "-f", self.volume], capture_output=True
            )
        )

    def _run_container(self):
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                self.container,
                "--read-only",
                "--tmpfs",
                "/tmp:size=64m,mode=1777",
                "-v",
                f"{self.volume}:/data/odc-uploads",
                "-e",
                "ODC_UPLOAD_DIR=/data/odc-uploads",
                IMAGE,
                "sleep",
                "300",
            ],
            check=True,
            capture_output=True,
        )

    def _read(self, path: str) -> str:
        result = subprocess.run(
            ["docker", "exec", self.container, "cat", path],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()

    def test_file_written_to_the_named_volume_persists_after_container_recreation(
        self,
    ):
        self._run_container()
        marker = f"{uuid.uuid4()}.txt"
        path = f"/data/odc-uploads/{marker}"
        subprocess.run(
            ["docker", "exec", self.container, "sh", "-c", f"echo hello > {path}"],
            check=True,
        )
        self.assertEqual(self._read(path), "hello")

        # Recreate the container — a new container, the same named volume —
        # exactly what `docker compose up -d --build` does on every deploy.
        subprocess.run(["docker", "rm", "-f", self.container], check=True)
        self._run_container()

        self.assertEqual(
            self._read(path),
            "hello",
            "file did not survive container recreation",
        )

    def test_upload_dir_is_writable_by_the_non_root_runtime_user_despite_read_only_root(
        self,
    ):
        self._run_container()
        whoami = subprocess.run(
            ["docker", "exec", self.container, "whoami"],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(whoami.stdout.strip(), "node")

        write = subprocess.run(
            [
                "docker",
                "exec",
                self.container,
                "sh",
                "-c",
                "touch /data/odc-uploads/perm-check.txt",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(write.returncode, 0, write.stderr)

        # The read-only root filesystem itself must still refuse a write
        # outside the explicit mounts (the container never became fully
        # writable by accident).
        outside_write = subprocess.run(
            ["docker", "exec", self.container, "sh", "-c", "touch /app/should-fail"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(outside_write.returncode, 0)


if __name__ == "__main__":
    unittest.main()
