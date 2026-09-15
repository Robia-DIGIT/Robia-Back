-- AlterTable
ALTER TABLE "action_items" ALTER COLUMN "updated_at" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "action_execution_events_organization_id_action_item_id_created_" RENAME TO "action_execution_events_organization_id_action_item_id_crea_idx";
