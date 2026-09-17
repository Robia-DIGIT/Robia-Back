-- RC-27 — automatic step-level retries. Additive, all nullable/defaulted:
-- a failed AutomationStepRun can now be retried automatically (with
-- backoff, via a two-phase claim mirroring RC-25's AutomationSchedulerService
-- and RC-26's NotificationDispatcherService) instead of always failing the
-- whole run on the first transient error. See docs/RC27_STEP_RETRIES.md.

-- AlterTable
ALTER TABLE "automation_step_runs"
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "claimed_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "automation_step_runs_status_next_attempt_at_idx" ON "automation_step_runs"("status", "next_attempt_at");
