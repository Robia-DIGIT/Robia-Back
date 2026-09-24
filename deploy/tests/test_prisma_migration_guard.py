"""hardening/prisma-migration-guard — proves the mandatory guard in front of
every `prisma migrate deploy` (scripts/safe-prisma-migrate.cjs) is actually
wired in, and actually works against a real PostgreSQL server.

Two tiers, mirroring the existing test_production_storage.py /
test_odc_storage_integration.py split in this same directory:

  * PrismaMigrationGuardWiringTests — static checks (Dockerfile text,
    `docker compose config` resolution). No Docker daemon required, so this
    is also meaningful in a daemon-less sandbox.

  * PrismaMigrationGuardContainerTests — builds the real `migrate` image
    from this repo's own Dockerfile and runs it against a real, ephemeral
    PostgreSQL container: the guard's own two `pg` connections are genuine
    TCP connections to a genuine server, exactly like the guard behaves in
    production. Requires a live Docker daemon — skipped cleanly (not
    failed) when one isn't reachable. This sandboxed session has no daemon;
    GitHub Actions' `deployment-tests` job does, so this actually executes
    there.
"""
import json
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = ROOT / "Dockerfile"
COMPOSE_FILE = ROOT / "docker-compose.production.yml"
ENV_EXAMPLE = ROOT / ".env.production.example"
ENV_PRODUCTION = ROOT / ".env.production"
GUARD_SCRIPT = ROOT / "scripts" / "safe-prisma-migrate.cjs"
IMAGE = "robia-backend:prisma-migration-guard-test"
POSTGRES_IMAGE = "pgvector/pgvector:pg16"
REFUSAL_EXIT_CODE = 42
# The literal password used only inside this test's own throwaway fixtures —
# never a real credential — so "no secret in stdout/stderr" can be asserted
# precisely rather than guessed at.
FIXTURE_PASSWORD = "guardtestpw123"


def _docker_daemon_reachable() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        result = subprocess.run(["docker", "info"], capture_output=True, timeout=10)
    except (subprocess.TimeoutExpired, OSError):
        return False
    return result.returncode == 0


class PrismaMigrationGuardWiringTests(unittest.TestCase):
    """Neither the Dockerfile nor docker-compose.production.yml may bypass
    the guard with a direct Prisma invocation — this is what makes it
    mandatory rather than merely available."""

    @classmethod
    def setUpClass(cls):
        cls.dockerfile_text = DOCKERFILE.read_text(encoding="utf-8")
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
        cls.migrate = cls.config["services"]["migrate"]

    def test_guard_script_exists_and_exports_the_expected_entry_points(self):
        self.assertTrue(GUARD_SCRIPT.is_file())
        source = GUARD_SCRIPT.read_text(encoding="utf-8")
        for symbol in ("runMigrationGuard", "REFUSAL_EXIT_CODE", "require.main === module"):
            self.assertIn(symbol, source)

    def test_dockerfile_migrate_stage_copies_the_guard_script(self):
        self.assertIn("scripts/safe-prisma-migrate.cjs ./scripts/safe-prisma-migrate.cjs", self.dockerfile_text)

    def test_dockerfile_migrate_stage_runs_as_non_root(self):
        migrate_stage = self.dockerfile_text.split("AS migrate", 1)[1].split("FROM ", 1)[0]
        self.assertIn("USER node", migrate_stage)

    def test_dockerfile_migrate_stage_cmd_runs_the_guard_not_prisma_directly(self):
        migrate_stage = self.dockerfile_text.split("AS migrate", 1)[1].split(
            "FROM ", 1
        )[0]
        instruction_lines = [
            line
            for line in migrate_stage.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        instructions = "\n".join(instruction_lines)
        self.assertIn(
            'CMD ["node", "/app/scripts/safe-prisma-migrate.cjs"]', instructions
        )
        self.assertNotIn("prisma migrate deploy", instructions)
        self.assertNotIn('prisma", "migrate', instructions)

    def test_compose_migrate_service_declares_the_required_guard_env(self):
        env = self.migrate["environment"]
        self.assertEqual(env.get("NODE_ENV"), "production")
        self.assertEqual(env.get("MIGRATION_ENVIRONMENT"), "production")
        self.assertEqual(env.get("EXPECTED_DATABASE_HOST"), "db")
        self.assertEqual(env.get("EXPECTED_DATABASE_NAME"), "postgres")
        self.assertEqual(env.get("npm_config_cache"), "/tmp/npm-cache")

    def test_compose_migrate_service_is_hardened(self):
        self.assertTrue(self.migrate.get("read_only"))
        self.assertIn("ALL", self.migrate.get("cap_drop", []))
        self.assertIn("no-new-privileges:true", self.migrate.get("security_opt", []))
        tmpfs_mounts = self.migrate.get("tmpfs", [])
        self.assertTrue(any(mount.startswith("/tmp") for mount in tmpfs_mounts))

    def test_env_production_example_documents_the_guard_variables_as_non_secret(self):
        text = ENV_EXAMPLE.read_text(encoding="utf-8")
        self.assertIn("EXPECTED_DATABASE_HOST=db", text)
        self.assertIn("EXPECTED_DATABASE_NAME=postgres", text)
        # MIGRATION_ENVIRONMENT is hardcoded in docker-compose.production.yml
        # (never read from .env.production) — this file must not assign it,
        # or the example would misleadingly suggest the VPS operator needs to
        # set a third variable that the compose file never actually reads.
        # (A prose mention explaining that fact, as in the comment above, is
        # fine — only an actual `MIGRATION_ENVIRONMENT=...` assignment isn't.)
        self.assertNotIn("\nMIGRATION_ENVIRONMENT=", text)


class PrismaMigrationGuardComposeRequiredVarsTests(unittest.TestCase):
    """`docker compose config` itself must refuse to resolve
    docker-compose.production.yml when EXPECTED_DATABASE_HOST or
    EXPECTED_DATABASE_NAME is missing — the mandatory guard must never be
    reachable at all with an incomplete env file, not merely rely on the
    guard script noticing at container-start time."""

    def _config_with_env(self, env_text: str) -> subprocess.CompletedProcess:
        # `docker compose config` resolves each service's own `env_file:
        # .env.production` line regardless of `--env-file` (see
        # PrismaMigrationGuardWiringTests.setUpClass above for the same
        # constraint) — both must point at the same content, or a missing
        # variable in ours would be masked by whatever real file exists.
        with tempfile.NamedTemporaryFile(
            "w", dir=ROOT, prefix=".env.production.test-", delete=False
        ) as handle:
            handle.write(env_text)
            temp_path = Path(handle.name)
        owns_env_production = not ENV_PRODUCTION.exists()
        if owns_env_production:
            ENV_PRODUCTION.write_text(env_text, encoding="utf-8")
        try:
            return subprocess.run(
                [
                    "docker",
                    "compose",
                    "--env-file",
                    str(temp_path),
                    "-f",
                    str(COMPOSE_FILE),
                    "config",
                    "--quiet",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=30,
            )
        finally:
            temp_path.unlink(missing_ok=True)
            if owns_env_production:
                ENV_PRODUCTION.unlink(missing_ok=True)

    def test_config_succeeds_when_both_expected_variables_are_present(self):
        result = self._config_with_env(ENV_EXAMPLE.read_text(encoding="utf-8"))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_config_refuses_when_expected_database_host_is_missing(self):
        text = ENV_EXAMPLE.read_text(encoding="utf-8")
        lines = [line for line in text.splitlines() if not line.startswith("EXPECTED_DATABASE_HOST=")]
        result = self._config_with_env("\n".join(lines) + "\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("EXPECTED_DATABASE_HOST", result.stderr)

    def test_config_refuses_when_expected_database_name_is_missing(self):
        text = ENV_EXAMPLE.read_text(encoding="utf-8")
        lines = [line for line in text.splitlines() if not line.startswith("EXPECTED_DATABASE_NAME=")]
        result = self._config_with_env("\n".join(lines) + "\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("EXPECTED_DATABASE_NAME", result.stderr)

    def test_config_refuses_when_expected_database_host_is_set_but_empty(self):
        text = ENV_EXAMPLE.read_text(encoding="utf-8")
        lines = [
            line
            for line in text.splitlines()
            if not line.startswith("EXPECTED_DATABASE_HOST=")
        ]
        lines.append("EXPECTED_DATABASE_HOST=")
        result = self._config_with_env("\n".join(lines) + "\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("EXPECTED_DATABASE_HOST", result.stderr)


@unittest.skipUnless(_docker_daemon_reachable(), "docker daemon not reachable")
class PrismaMigrationGuardContainerTests(unittest.TestCase):
    """Builds the real `migrate` image and runs it against a real,
    ephemeral PostgreSQL server — the guard's two `pg` connections in these
    tests are genuine TCP connections, never mocked."""

    @classmethod
    def setUpClass(cls):
        subprocess.run(
            ["docker", "build", "--target", "migrate", "--tag", IMAGE, str(ROOT)],
            check=True,
            cwd=ROOT,
            capture_output=True,
            timeout=600,
        )

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["docker", "rmi", "-f", IMAGE], capture_output=True)

    def setUp(self):
        unique = uuid.uuid4().hex[:8]
        self.network = f"robia-guard-test-net-{unique}"
        self.allowed_pg = f"robia-guard-test-allowed-{unique}"
        self.other_pg = f"robia-guard-test-other-{unique}"
        subprocess.run(["docker", "network", "create", self.network], check=True, capture_output=True)
        self.addCleanup(
            lambda: subprocess.run(["docker", "network", "rm", self.network], capture_output=True)
        )

    def _start_postgres(self, name: str, database: str) -> None:
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                name,
                "--network",
                self.network,
                "-e",
                f"POSTGRES_PASSWORD={FIXTURE_PASSWORD}",
                "-e",
                f"POSTGRES_DB={database}",
                POSTGRES_IMAGE,
            ],
            check=True,
            capture_output=True,
        )
        self.addCleanup(lambda: subprocess.run(["docker", "rm", "-f", name], capture_output=True))
        self._wait_until_ready(name)

    def _wait_until_ready(self, name: str, attempts: int = 60) -> None:
        for _ in range(attempts):
            result = subprocess.run(
                ["docker", "exec", name, "pg_isready", "-U", "postgres"],
                capture_output=True,
                timeout=5,
            )
            if result.returncode == 0:
                return
            subprocess.run(["sleep", "1"])
        raise RuntimeError(f"PostgreSQL container {name} never became ready")

    def _migrations_table_exists(self, pg_container: str, database: str) -> bool:
        result = subprocess.run(
            [
                "docker",
                "exec",
                pg_container,
                "psql",
                "-U",
                "postgres",
                "-d",
                database,
                "-tAc",
                "select to_regclass('public._prisma_migrations') is not null;",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip() == "t"

    def _run_migrate_container(self, env: dict) -> subprocess.CompletedProcess:
        args = ["docker", "run", "--rm", "--network", self.network]
        for key, value in env.items():
            args += ["-e", f"{key}={value}"]
        args.append(IMAGE)
        return subprocess.run(args, capture_output=True, text=True, timeout=120)

    def test_matching_urls_and_real_target_run_the_real_migration(self):
        database = "robia_guard_ok"
        self._start_postgres(self.allowed_pg, database)
        url = (
            f"postgresql://postgres:{FIXTURE_PASSWORD}@{self.allowed_pg}:5432/"
            f"{database}?schema=public"
        )

        result = self._run_migrate_container(
            {
                "DATABASE_URL": url,
                "DIRECT_URL": url,
                "EXPECTED_DATABASE_HOST": self.allowed_pg,
                "EXPECTED_DATABASE_NAME": database,
            }
        )

        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, combined)
        self.assertTrue(self._migrations_table_exists(self.allowed_pg, database))
        self.assertNotIn(FIXTURE_PASSWORD, combined)

    def test_direct_url_pointing_at_a_different_real_server_is_refused(self):
        allowed_db = "robia_guard_allowed"
        other_db = "robia_guard_other"
        self._start_postgres(self.allowed_pg, allowed_db)
        self._start_postgres(self.other_pg, other_db)

        # DATABASE_URL (runtime) points at the intended server; DIRECT_URL
        # (migration) points at a completely different real PostgreSQL
        # server — the exact QA/production mismatch this guard exists for.
        database_url = (
            f"postgresql://postgres:{FIXTURE_PASSWORD}@{self.allowed_pg}:5432/"
            f"{allowed_db}?schema=public"
        )
        direct_url = (
            f"postgresql://postgres:{FIXTURE_PASSWORD}@{self.other_pg}:5432/"
            f"{other_db}?schema=public"
        )

        result = self._run_migrate_container(
            {
                "DATABASE_URL": database_url,
                "DIRECT_URL": direct_url,
                "EXPECTED_DATABASE_HOST": self.other_pg,
                "EXPECTED_DATABASE_NAME": other_db,
            }
        )

        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, REFUSAL_EXIT_CODE, combined)
        self.assertFalse(self._migrations_table_exists(self.allowed_pg, allowed_db))
        self.assertFalse(self._migrations_table_exists(self.other_pg, other_db))
        self.assertNotIn(FIXTURE_PASSWORD, combined)
        self.assertNotIn(database_url, combined)
        self.assertNotIn(direct_url, combined)

    def test_migrate_container_does_not_run_as_root(self):
        # hardening/prisma-migration-guard — the `migrate` stage now runs as
        # `USER node` (see Dockerfile): a process opening real network
        # connections to production PostgreSQL has no legitimate need for
        # UID 0. Overrides the default CMD with `id -u` to read back the
        # actual effective UID the container runs as, independent of what
        # the Dockerfile merely claims.
        result = subprocess.run(
            ["docker", "run", "--rm", "--entrypoint", "id", IMAGE, "-u"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        uid = result.stdout.strip()
        self.assertNotEqual(uid, "0", f"migrate container runs as UID {uid!r}, expected non-root")

    def test_unreachable_database_host_is_refused_within_the_bounded_timeout(self):
        # No PostgreSQL server is ever started at this address. A private,
        # non-routable IP is used rather than an unused port on a live host,
        # because the latter fails almost instantly with ECONNREFUSED and
        # would never prove that a genuine hang is actually bounded. Without
        # connectionTimeoutMillis, `pg`'s TCP connect would only give up on
        # the OS's own retry timeout (commonly well over a minute); the
        # guard must fail in roughly 10 seconds instead.
        unreachable_host = "10.255.255.1"
        url = (
            f"postgresql://postgres:{FIXTURE_PASSWORD}@{unreachable_host}:5432/"
            f"postgres?schema=public"
        )

        started = time.monotonic()
        result = self._run_migrate_container(
            {
                "DATABASE_URL": url,
                "DIRECT_URL": url,
                "EXPECTED_DATABASE_HOST": unreachable_host,
                "EXPECTED_DATABASE_NAME": "postgres",
                "MIGRATION_ENVIRONMENT": "production",
            }
        )
        elapsed = time.monotonic() - started

        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, REFUSAL_EXIT_CODE, combined)
        self.assertLess(
            elapsed,
            30,
            f"guard took {elapsed:.1f}s against an unreachable host — the 10s "
            "connection timeout does not appear to bound pg's connect()",
        )
        self.assertNotIn(FIXTURE_PASSWORD, combined)
        self.assertNotIn(url, combined)

    def test_postgres_database_name_is_refused_without_explicit_production_environment(self):
        # The database is literally named "postgres" (matching the real
        # production target) but MIGRATION_ENVIRONMENT is deliberately left
        # unset — the staging posture — so this must be refused even though
        # DATABASE_URL and DIRECT_URL agree with each other and with the
        # expected host/name.
        self._start_postgres(self.allowed_pg, "postgres")
        url = (
            f"postgresql://postgres:{FIXTURE_PASSWORD}@{self.allowed_pg}:5432/"
            f"postgres?schema=public"
        )

        result = self._run_migrate_container(
            {
                "DATABASE_URL": url,
                "DIRECT_URL": url,
                "EXPECTED_DATABASE_HOST": self.allowed_pg,
                "EXPECTED_DATABASE_NAME": "postgres",
            }
        )

        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, REFUSAL_EXIT_CODE, combined)
        self.assertFalse(self._migrations_table_exists(self.allowed_pg, "postgres"))


if __name__ == "__main__":
    unittest.main()
