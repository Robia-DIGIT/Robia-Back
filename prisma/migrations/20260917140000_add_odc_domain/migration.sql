-- RC-29 — Orange Digital Center candidature workflow. New, additive domain:
-- 9 tables, all under organization_id isolation, no changes to any existing
-- table. See docs/RC29_ODC_CANDIDATURES.md.


-- CreateTable
CREATE TABLE "odc_programs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "opens_at" TIMESTAMP(3),
    "closes_at" TIMESTAMP(3),
    "require_dual_review" BOOLEAN NOT NULL DEFAULT false,
    "decision_threshold" INTEGER,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "odc_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odc_fields" (
    "id" TEXT NOT NULL,
    "program_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "field_type" TEXT NOT NULL,
    "options" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "odc_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odc_criteria" (
    "id" TEXT NOT NULL,
    "program_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "max_points" INTEGER NOT NULL DEFAULT 5,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "odc_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odc_document_types" (
    "id" TEXT NOT NULL,
    "program_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "mime_allow" TEXT[] DEFAULT ARRAY['application/pdf']::TEXT[],

    CONSTRAINT "odc_document_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odc_applicants" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odc_applicants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odc_applications" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "program_id" TEXT NOT NULL,
    "applicant_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "proposed_total" INTEGER,
    "final_total" INTEGER,
    "summary_draft" TEXT,
    "missing" JSONB,
    "submitted_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "decided_by_id" TEXT,
    "decision_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "odc_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odc_documents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "document_type_id" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odc_score_lines" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "criterion_id" TEXT NOT NULL,
    "proposed_points" INTEGER,
    "proposed_by" TEXT NOT NULL DEFAULT 'ai',
    "final_points" INTEGER,
    "rationale" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "odc_score_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odc_history_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "event_type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odc_history_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "odc_programs_organization_id_status_idx" ON "odc_programs"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "odc_programs_organization_id_slug_key" ON "odc_programs"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "odc_fields_program_id_key_key" ON "odc_fields"("program_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "odc_criteria_program_id_key_key" ON "odc_criteria"("program_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "odc_document_types_program_id_key_key" ON "odc_document_types"("program_id", "key");

-- CreateIndex
CREATE INDEX "odc_applicants_organization_id_email_idx" ON "odc_applicants"("organization_id", "email");

-- CreateIndex
CREATE INDEX "odc_applications_organization_id_status_idx" ON "odc_applications"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "odc_applications_program_id_applicant_id_key" ON "odc_applications"("program_id", "applicant_id");

-- CreateIndex
CREATE INDEX "odc_documents_organization_id_application_id_idx" ON "odc_documents"("organization_id", "application_id");

-- CreateIndex
CREATE UNIQUE INDEX "odc_score_lines_application_id_criterion_id_key" ON "odc_score_lines"("application_id", "criterion_id");

-- CreateIndex
CREATE INDEX "odc_history_events_organization_id_application_id_created_a_idx" ON "odc_history_events"("organization_id", "application_id", "created_at");

-- AddForeignKey
ALTER TABLE "odc_programs" ADD CONSTRAINT "odc_programs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_fields" ADD CONSTRAINT "odc_fields_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "odc_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_criteria" ADD CONSTRAINT "odc_criteria_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "odc_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_document_types" ADD CONSTRAINT "odc_document_types_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "odc_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_applicants" ADD CONSTRAINT "odc_applicants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_applications" ADD CONSTRAINT "odc_applications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_applications" ADD CONSTRAINT "odc_applications_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "odc_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_applications" ADD CONSTRAINT "odc_applications_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "odc_applicants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_applications" ADD CONSTRAINT "odc_applications_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_documents" ADD CONSTRAINT "odc_documents_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "odc_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_documents" ADD CONSTRAINT "odc_documents_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "odc_document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_score_lines" ADD CONSTRAINT "odc_score_lines_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "odc_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_score_lines" ADD CONSTRAINT "odc_score_lines_criterion_id_fkey" FOREIGN KEY ("criterion_id") REFERENCES "odc_criteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odc_history_events" ADD CONSTRAINT "odc_history_events_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "odc_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

