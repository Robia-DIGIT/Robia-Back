-- RC-49 — ODC public candidate portal (backend only). Additive: two new
-- columns on existing tables (both safely defaulted/backfilled below) and
-- one new table. No existing column is dropped, renamed or retyped.

-- AlterTable: OdcHistoryEvent gains actor_type, distinguishing 'staff' /
-- 'system' / 'applicant' actors. Every row created before this migration
-- predates the public portal, so it can only ever be 'staff' (a real
-- actor_user_id was recorded) or 'system' (an automatic screening
-- transition recorded none) — never 'applicant'.
ALTER TABLE "odc_history_events" ADD COLUMN "actor_type" TEXT NOT NULL DEFAULT 'staff';
UPDATE "odc_history_events" SET "actor_type" = 'system' WHERE "actor_user_id" IS NULL;

-- AlterTable: OdcProgram gains public_key, the URL identifier the public
-- portal resolves a program by (never the staff-facing `slug`). Existing
-- rows get a random, unique value backfilled before the column is made
-- NOT NULL + UNIQUE; every row created after this migration gets one from
-- Prisma's own @default(cuid()) at insert time instead.
ALTER TABLE "odc_programs" ADD COLUMN "public_key" TEXT;
UPDATE "odc_programs" SET "public_key" = replace(gen_random_uuid()::text, '-', '') WHERE "public_key" IS NULL;
ALTER TABLE "odc_programs" ALTER COLUMN "public_key" SET NOT NULL;
CREATE UNIQUE INDEX "odc_programs_public_key_key" ON "odc_programs"("public_key");

-- CreateTable
CREATE TABLE "odc_applicant_sessions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odc_applicant_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "odc_applicant_sessions_token_hash_key" ON "odc_applicant_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "odc_applicant_sessions_expires_at_idx" ON "odc_applicant_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "odc_applicant_sessions_organization_id_application_id_idx" ON "odc_applicant_sessions"("organization_id", "application_id");

-- AddForeignKey
ALTER TABLE "odc_applicant_sessions" ADD CONSTRAINT "odc_applicant_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_applicant_sessions" ADD CONSTRAINT "odc_applicant_sessions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "odc_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
