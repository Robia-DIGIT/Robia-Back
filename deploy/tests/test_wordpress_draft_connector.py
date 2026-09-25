"""Static deployment and migration invariants for RC42 WordPress drafts."""

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "prisma" / "schema.prisma"
MIGRATION = (
    ROOT
    / "prisma"
    / "migrations"
    / "20260924130000_wordpress_draft_connector"
    / "migration.sql"
)
ENV_EXAMPLE = ROOT / ".env.production.example"
SERVICE = ROOT / "src" / "integrations" / "wordpress.service.ts"
TRANSPORT = ROOT / "src" / "integrations" / "wordpress-safe-http.service.ts"


class WordPressDraftConnectorDeploymentTests(unittest.TestCase):
    def test_migration_is_additive_and_creates_all_three_tables(self):
        sql = MIGRATION.read_text(encoding="utf-8")
        for table in (
            "wordpress_connections",
            "wordpress_draft_approvals",
            "wordpress_draft_attempts",
        ):
            self.assertIn(f'CREATE TABLE "{table}"', sql)
        self.assertNotIn("DROP TABLE", sql.upper())
        self.assertNotIn("DROP COLUMN", sql.upper())

    def test_migration_has_remote_write_uniqueness_constraints(self):
        sql = MIGRATION.read_text(encoding="utf-8")
        self.assertIn(
            'CREATE UNIQUE INDEX "wordpress_draft_attempts_approval_id_key"', sql
        )
        self.assertIn(
            'CREATE UNIQUE INDEX "wordpress_draft_attempts_operation_key_key"', sql
        )
        self.assertIn(
            '"wordpress_draft_attempts_organization_id_idempotency_key_key"', sql
        )

    def test_schema_and_migration_both_keep_credentials_nullable(self):
        schema = SCHEMA.read_text(encoding="utf-8")
        sql = MIGRATION.read_text(encoding="utf-8")
        self.assertIn("encryptedApplicationPassword String?", schema)
        self.assertIn('"encrypted_application_password" TEXT,', sql)

    def test_dedicated_encryption_key_is_documented(self):
        env = ENV_EXAMPLE.read_text(encoding="utf-8")
        self.assertIn("WORDPRESS_CREDENTIAL_ENCRYPTION_KEY=", env)
        self.assertNotIn(
            "WORDPRESS_CREDENTIAL_ENCRYPTION_KEY=${GOOGLE_TOKEN_ENCRYPTION_KEY}", env
        )

    def test_service_can_only_send_wordpress_drafts(self):
        source = SERVICE.read_text(encoding="utf-8")
        self.assertIn("status: 'draft'", source)
        self.assertNotIn("status: 'publish'", source)
        self.assertNotIn("status: \"publish\"", source)

    def test_transport_pins_dns_and_does_not_follow_redirects(self):
        source = TRANSPORT.read_text(encoding="utf-8")
        self.assertIn("lookup:", source)
        self.assertIn("selected.address", source)
        self.assertNotIn("redirect", source.lower())


if __name__ == "__main__":
    unittest.main()
