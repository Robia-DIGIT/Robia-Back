-- RC38 hardening: stable Google identity, durable synchronization claim,
-- honest attempt/success timestamps, and idempotent browser-cache import.

ALTER TABLE "google_business_profile_connections"
  ADD COLUMN "google_account_subject" TEXT,
  ADD COLUMN "last_sync_attempt_at" TIMESTAMP(3),
  ADD COLUMN "last_sync_status" TEXT NOT NULL DEFAULT 'never',
  ADD COLUMN "sync_claimed_at" TIMESTAMP(3),
  ADD COLUMN "sync_claim_token" TEXT;

ALTER TABLE "locations" ADD COLUMN "legacy_import_key" TEXT;

ALTER TABLE "google_business_profile_connections"
  ADD CONSTRAINT "google_business_profile_connections_last_sync_status_check"
  CHECK ("last_sync_status" IN ('never', 'running', 'success', 'partial', 'failed'));

CREATE UNIQUE INDEX "locations_organization_id_legacy_import_key_key"
  ON "locations"("organization_id", "legacy_import_key");

UPDATE "google_business_profile_connections"
SET "last_sync_status" = 'success'
WHERE "last_synced_at" IS NOT NULL;
