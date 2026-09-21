-- RC-33 hardening — multiple-documents policy: atomic replacement. At most
-- one OdcDocument row may exist per (application_id, document_type_id)
-- from now on; a new upload atomically replaces whatever occupied that
-- slot (see OdcApplicationsService.addUploadedDocument()).
--
-- Existing-rows plan: a slot that already holds more than one row (e.g. a
-- pre-hardening addDocument() placeholder left alongside a later real
-- upload, or two uploads that raced before this constraint existed) is
-- deduplicated first — keep exactly one row per slot, the rest deleted.
--
-- RC-33 hardening (Codex review) — a plain "keep the newest row" rule is
-- wrong here: a placeholder can be re-created as `pending_upload` (no
-- storage_key) *after* a real file already landed as `received`, e.g. a
-- client retried a stalled upload UI action following a successful upload.
-- Blindly keeping the most recent row would keep that empty placeholder
-- and silently delete the row that is the only reference to a real file on
-- disk (see OdcApplicationsService.addUploadedDocument()'s own
-- storageKeyBelongsTo() ownership check — a slot with no still-referenced
-- row for a file means that file leaks forever, never listed, never
-- served, never cleaned up).
--
-- Ranking per slot, highest priority first:
--   1. `received` with a non-null storage_key — an actual uploaded file
--      this row is the only reference to;
--   2. anything else (pending_upload, rejected, or a received row that
--      somehow has no storage_key);
--   3. created_at DESC — most recent first, within the same tier;
--   4. id DESC — deterministic tiebreak for equal created_at.
-- This is a one-time, deterministic reconciliation, run once by this
-- migration, never repeated.

DELETE FROM "odc_documents" d
USING (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY application_id, document_type_id
    ORDER BY
      (status = 'received' AND storage_key IS NOT NULL) DESC,
      created_at DESC,
      id DESC
  ) AS rank
  FROM "odc_documents"
) ranked
WHERE d.id = ranked.id
  AND ranked.rank > 1;

-- CreateIndex
CREATE UNIQUE INDEX "odc_documents_application_id_document_type_id_key" ON "odc_documents"("application_id", "document_type_id");
