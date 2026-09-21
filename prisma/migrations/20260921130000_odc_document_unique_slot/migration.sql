-- RC-33 hardening — multiple-documents policy: atomic replacement. At most
-- one OdcDocument row may exist per (application_id, document_type_id)
-- from now on; a new upload atomically replaces whatever occupied that
-- slot (see OdcApplicationsService.addUploadedDocument()).
--
-- Existing-rows plan: a slot that already holds more than one row (e.g. a
-- pre-hardening addDocument() placeholder left alongside a later real
-- upload, or two uploads that raced before this constraint existed) is
-- deduplicated first — keep only the most recently created row per slot
-- (ties broken by id), the same createdAt DESC "current document" rule
-- the policy itself is built on; delete the rest. This is a one-time,
-- deterministic reconciliation, run once by this migration, never repeated.

DELETE FROM "odc_documents" d
USING "odc_documents" d2
WHERE d.application_id = d2.application_id
  AND d.document_type_id = d2.document_type_id
  AND (d.created_at, d.id) < (d2.created_at, d2.id);

-- CreateIndex
CREATE UNIQUE INDEX "odc_documents_application_id_document_type_id_key" ON "odc_documents"("application_id", "document_type_id");
