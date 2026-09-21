"""RC-33 hardening (Codex review) — proves the odc_documents dedup migration
(prisma/migrations/20260921130000_odc_document_unique_slot/migration.sql)
against a real PostgreSQL 16 server, not a mock or an in-memory fake.

The scenario the review flagged: a slot can hold an *older* `received` row
that is the only reference to a real uploaded file (non-null storage_key)
alongside a *newer* `pending_upload` row with no storage_key (e.g. a client
retried a stalled upload UI action after the real upload had already
succeeded). A naive "keep the most recent row" dedup would delete the
`received` row and silently orphan the file on disk forever. This runs the
migration's actual DELETE statement, verbatim, against real rows in a real
Postgres server and asserts the `received` row survives.

Requires a live Docker daemon (to run a disposable `postgres:16` container)
— skipped cleanly (not failed) when one isn't reachable, exactly like
test_odc_storage_integration.py. This sandboxed session has no daemon;
GitHub Actions' `deployment-tests` job does, so this test actually executes
there.
"""
import shutil
import subprocess
import time
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATION_SQL = (
    ROOT
    / "prisma"
    / "migrations"
    / "20260921130000_odc_document_unique_slot"
    / "migration.sql"
)
PG_IMAGE = "postgres:16"
DB_NAME = "odc_migration_test"
DB_USER = "postgres"
DB_PASSWORD = "test"


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


def _extract_delete_statement(migration_sql: str) -> str:
    """Pulls out only the DELETE ... statement from the migration file
    (everything up to but excluding the CreateIndex), so this test runs the
    exact same dedup logic the migration ships, never a hand-copied
    approximation of it."""
    marker = "-- CreateIndex"
    assert marker in migration_sql, "migration.sql shape changed unexpectedly"
    return migration_sql.split(marker)[0]


@unittest.skipUnless(_docker_daemon_reachable(), "docker daemon not reachable")
class OdcDocumentDedupMigrationTests(unittest.TestCase):
    """Runs the real migration.sql DELETE against a disposable, real
    PostgreSQL 16 container — proving the ranking (received+storage_key >
    everything else > created_at DESC > id DESC) holds against the actual
    engine's window-function and DELETE...USING semantics, not just our own
    reading of the SQL."""

    @classmethod
    def setUpClass(cls):
        cls.migration_delete_sql = _extract_delete_statement(
            MIGRATION_SQL.read_text()
        )
        unique = uuid.uuid4().hex[:8]
        cls.container = f"robia-odc-migration-test-{unique}"
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--name",
                cls.container,
                "-e",
                f"POSTGRES_PASSWORD={DB_PASSWORD}",
                "-e",
                f"POSTGRES_DB={DB_NAME}",
                PG_IMAGE,
            ],
            check=True,
            capture_output=True,
        )
        cls._wait_until_ready()
        cls._exec_sql(
            """
            CREATE TABLE odc_documents (
              id text primary key,
              application_id text not null,
              document_type_id text not null,
              storage_key text,
              status text not null default 'received',
              created_at timestamptz not null default now()
            );
            """
        )

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["docker", "rm", "-f", cls.container], capture_output=True)

    @classmethod
    def _wait_until_ready(cls, timeout_seconds: int = 30):
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            result = subprocess.run(
                ["docker", "exec", cls.container, "pg_isready", "-U", DB_USER],
                capture_output=True,
            )
            if result.returncode == 0:
                return
            time.sleep(1)
        raise TimeoutError("postgres container never became ready")

    @classmethod
    def _exec_sql(cls, sql: str, extra_args: list[str] | None = None) -> str:
        result = subprocess.run(
            [
                "docker",
                "exec",
                "-i",
                cls.container,
                "psql",
                "-U",
                DB_USER,
                "-d",
                DB_NAME,
                "-v",
                "ON_ERROR_STOP=1",
                *(extra_args or []),
            ],
            input=sql,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"psql failed (rc={result.returncode}):\n"
                f"stdout={result.stdout}\nstderr={result.stderr}"
            )
        return result.stdout

    @classmethod
    def _query(cls, sql: str) -> str:
        # -t (tuples only) -A (unaligned) — raw values, one per line, no
        # header/footer/dashes to strip.
        return cls._exec_sql(sql, extra_args=["-t", "-A"])

    def setUp(self):
        self._exec_sql("TRUNCATE odc_documents;")

    def _insert(self, id_, application_id, document_type_id, storage_key, status, age):
        storage_key_sql = "NULL" if storage_key is None else f"'{storage_key}'"
        self._exec_sql(
            f"""
            INSERT INTO odc_documents
              (id, application_id, document_type_id, storage_key, status, created_at)
            VALUES
              ('{id_}', '{application_id}', '{document_type_id}',
               {storage_key_sql}, '{status}', now() - interval '{age}');
            """
        )

    def _remaining_ids(self, application_id: str, document_type_id: str) -> list[str]:
        output = self._query(
            f"""
            SELECT id FROM odc_documents
            WHERE application_id = '{application_id}'
              AND document_type_id = '{document_type_id}'
            ORDER BY id;
            """
        )
        return [line.strip() for line in output.splitlines() if line.strip()]

    def test_older_received_row_with_storage_key_survives_over_a_newer_pending_upload(
        self,
    ):
        # The exact scenario the review flagged: an older row is the only
        # reference to a real uploaded file; a newer row in the same slot
        # is an empty placeholder with no file behind it at all.
        self._insert(
            "doc-old-received",
            "app-1",
            "type-1",
            "org-1/app-1/doc-old-received/11111111-1111-1111-1111-111111111111.pdf",
            "received",
            "1 day",
        )
        self._insert(
            "doc-new-pending", "app-1", "type-1", None, "pending_upload", "0 seconds"
        )

        self._exec_sql(self.migration_delete_sql)

        remaining = self._remaining_ids("app-1", "type-1")
        self.assertEqual(remaining, ["doc-old-received"])

    def test_unique_constraint_is_creatable_after_dedup(self):
        self._insert(
            "doc-old-received",
            "app-1",
            "type-1",
            "org-1/app-1/doc-old-received/11111111-1111-1111-1111-111111111111.pdf",
            "received",
            "1 day",
        )
        self._insert(
            "doc-new-pending", "app-1", "type-1", None, "pending_upload", "0 seconds"
        )

        self._exec_sql(self.migration_delete_sql)
        self._exec_sql(
            """
            CREATE UNIQUE INDEX odc_documents_application_id_document_type_id_key
              ON odc_documents (application_id, document_type_id);
            """
        )

        with self.assertRaises(AssertionError):
            self._exec_sql(
                """
                INSERT INTO odc_documents
                  (id, application_id, document_type_id, status)
                VALUES ('doc-should-violate', 'app-1', 'type-1', 'pending_upload');
                """
            )

    def test_normal_same_tier_ties_still_break_on_created_at_then_id(self):
        self._insert("doc-a", "app-2", "type-2", None, "pending_upload", "2 hours")
        self._insert("doc-b", "app-2", "type-2", None, "pending_upload", "0 seconds")

        self._exec_sql(self.migration_delete_sql)

        remaining = self._remaining_ids("app-2", "type-2")
        self.assertEqual(remaining, ["doc-b"])


if __name__ == "__main__":
    unittest.main()
