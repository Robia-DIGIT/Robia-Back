-- RC-31 sequential human-approved candidate emails
CREATE TABLE "odc_outreaches" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "program_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "template_key" TEXT NOT NULL DEFAULT 'odc_candidate_invite',
    "approved_by_id" TEXT,
    "sent_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "odc_outreaches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "odc_outreaches_application_id_key" ON "odc_outreaches"("application_id");
CREATE INDEX "odc_outreaches_organization_id_program_id_sort_order_idx" ON "odc_outreaches"("organization_id", "program_id", "sort_order");

ALTER TABLE "odc_outreaches" ADD CONSTRAINT "odc_outreaches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "odc_outreaches" ADD CONSTRAINT "odc_outreaches_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "odc_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "odc_outreaches" ADD CONSTRAINT "odc_outreaches_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "odc_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "odc_outreaches" ADD CONSTRAINT "odc_outreaches_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
