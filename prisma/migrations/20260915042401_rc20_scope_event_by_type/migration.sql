-- RC-20 follow-up (Codex re-review round): scope AutomationEvent uniqueness
-- by eventType, not just eventKey.
--
-- Excluded from this migration (pre-existing, unrelated schema drift also
-- observed and deliberately excluded from the RC-20 migrations before this
-- one — see docs/RC20_OPS_AUTOMATION_CORE.md):
--   ALTER TABLE "action_items" ALTER COLUMN "updated_at" DROP DEFAULT;
--   ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL;
--   ALTER INDEX "action_execution_events_organization_id_action_item_id_created_"
--     RENAME TO "action_execution_events_organization_id_action_item_id_crea_idx";

-- An eventKey is only guaranteed unique within its own eventType (two
-- unrelated event types could coincidentally use the same key string).
-- Without this, reusing the same eventKey for a different eventType would
-- make getOrCreateEvent() silently return the wrong row — the wrong
-- payload — to whatever automations match the new type.
DROP INDEX "automation_events_organization_id_event_key_key";
CREATE UNIQUE INDEX "automation_events_organization_id_event_type_event_key_key"
  ON "automation_events"("organization_id", "event_type", "event_key");
