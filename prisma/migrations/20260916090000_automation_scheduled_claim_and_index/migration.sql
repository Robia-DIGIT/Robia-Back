-- RC-25 review fix: a lease on the in-flight scheduled claim, so a crash
-- between claiming a due occurrence and durably creating its run can never
-- lose that occurrence (nextRunAt itself is only advanced after the run
-- exists — see AutomationSchedulerService). Additive, nullable.

-- AlterTable
ALTER TABLE "automations" ADD COLUMN "scheduled_claimed_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "automations_enabled_next_run_at_idx" ON "automations"("enabled", "next_run_at");
