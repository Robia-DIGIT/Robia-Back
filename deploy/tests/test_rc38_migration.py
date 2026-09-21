import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = (
    ROOT
    / "prisma"
    / "migrations"
    / "20260921150000_rc38_oauth_sync_and_legacy_import"
    / "migration.sql"
)


class Rc38MigrationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = MIGRATION.read_text(encoding="utf-8")

    def test_is_additive_and_preserves_existing_rows(self):
        normalized = self.sql.upper()
        self.assertNotIn("DROP TABLE", normalized)
        self.assertNotIn("DROP COLUMN", normalized)
        self.assertIn('ADD COLUMN "google_account_subject" TEXT', self.sql)
        self.assertIn('ADD COLUMN "legacy_import_key" TEXT', self.sql)

    def test_backfills_success_only_after_the_status_column_exists(self):
        add_position = self.sql.index('ADD COLUMN "last_sync_status"')
        backfill_position = self.sql.index(
            'UPDATE "google_business_profile_connections"'
        )
        self.assertLess(add_position, backfill_position)
        self.assertIn("WHERE \"last_synced_at\" IS NOT NULL", self.sql)

    def test_enforces_status_and_legacy_import_invariants(self):
        self.assertIn(
            "CHECK (\"last_sync_status\" IN "
            "('never', 'running', 'success', 'partial', 'failed'))",
            self.sql,
        )
        self.assertIn(
            'ON "locations"("organization_id", "legacy_import_key")',
            self.sql,
        )


if __name__ == "__main__":
    unittest.main()
