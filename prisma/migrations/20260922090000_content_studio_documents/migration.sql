ALTER TABLE "documents"
  ADD COLUMN "website_id" TEXT,
  ADD COLUMN "brief" JSONB,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

UPDATE "documents" AS document
SET "website_id" = audit."website_id"
FROM "opportunities" AS opportunity
JOIN "audits" AS audit ON audit."id" = opportunity."audit_id"
WHERE document."opportunity_id" = opportunity."id";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "documents" WHERE "website_id" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill documents.website_id';
  END IF;
END $$;

ALTER TABLE "documents"
  ALTER COLUMN "website_id" SET NOT NULL,
  ALTER COLUMN "opportunity_id" DROP NOT NULL;

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_website_id_fkey"
  FOREIGN KEY ("website_id") REFERENCES "websites"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "documents_organization_id_website_id_updated_at_idx"
  ON "documents"("organization_id", "website_id", "updated_at");
