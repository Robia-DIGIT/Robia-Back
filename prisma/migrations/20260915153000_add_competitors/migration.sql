-- RC-24: Concurrents tab. A Competitor is deliberately NOT an
-- Audit/Website row so that running it never emits RC-23's
-- audit.completed event, never creates Opportunities, and never touches
-- web_pages (FK'd to the org's own crawled site).

-- CreateTable
CREATE TABLE "competitors" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "website_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "global_score" INTEGER,
    "result_json" JSONB,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "competitors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "competitors_organization_id_idx" ON "competitors"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "competitors_website_id_url_key" ON "competitors"("website_id", "url");

-- AddForeignKey
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
