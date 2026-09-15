-- RC-20 follow-up (Codex review round): execution-plan snapshot + concurrency guards.
--
-- Excluded from this migration (pre-existing, unrelated schema drift also
-- observed and deliberately excluded from the original RC-20 migration
-- 20260914164711_add_ops_automation_core — see docs/RC20_OPS_AUTOMATION_CORE.md):
--   ALTER TABLE "action_items" ALTER COLUMN "updated_at" DROP DEFAULT;
--   ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL;
--   ALTER INDEX "action_execution_events_organization_id_action_item_id_created_"
--     RENAME TO "action_execution_events_organization_id_action_item_id_crea_idx";

-- AlterTable: immutable per-run snapshot of the steps that were planned at
-- trigger time (Codex review: approval must execute the exact plan that was
-- reviewed, not the automation's current, possibly since-edited, steps).
ALTER TABLE "automation_runs" ADD COLUMN "planned_steps" JSONB;

-- Replace the plain index with a real uniqueness guarantee: two step runs
-- for the same run can never share a sequence number (defense against
-- duplicate step-row creation).
DROP INDEX "automation_step_runs_run_id_sequence_idx";
CREATE UNIQUE INDEX "automation_step_runs_run_id_sequence_key" ON "automation_step_runs"("run_id", "sequence");

-- Partial unique index: at most one automation_run per automation may be in
-- an active status at any time. This is the actual DB-level enforcement of
-- the "one active run per automation" guardrail (Codex review: the
-- application's previous check-then-create was a race, not a guarantee).
-- AutomationsService.persistRun() catches the resulting unique-violation and
-- maps it to AutomationRunConflictError.
CREATE UNIQUE INDEX "automation_runs_one_active_per_automation"
  ON "automation_runs" ("automation_id")
  WHERE "status" IN ('queued', 'running', 'waiting_approval');
