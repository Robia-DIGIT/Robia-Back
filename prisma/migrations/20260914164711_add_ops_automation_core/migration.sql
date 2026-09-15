-- RC-20 note: `prisma migrate dev` also proposed dropping the DB-level
-- default on action_items.updated_at and the NOT NULL constraint on
-- users.name — pre-existing drift between schema.prisma and migration
-- history from RC-14/RC-16, unrelated to Ops Automation. Left out of this
-- migration on purpose to keep it additive-only; flagged separately rather
-- than silently bundled here.

-- CreateTable
CREATE TABLE "automations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'ORGANIZATION',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "conditions" JSONB,
    "steps" JSONB NOT NULL,
    "requires_approval" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_triggers" (
    "id" TEXT NOT NULL,
    "automation_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "cron_expression" TEXT,
    "event_type" TEXT,
    "config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "automation_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "trigger_type" TEXT NOT NULL,
    "source_event_id" TEXT,
    "dedup_key" TEXT NOT NULL,
    "triggered_by_id" TEXT,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "approval_status" TEXT,
    "approved_by_id" TEXT,
    "approval_reason" TEXT,
    "approved_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error_message" TEXT,
    "context" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_step_runs" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "action_type" TEXT NOT NULL,
    "input" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "evidence" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_step_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automations_organization_id_idx" ON "automations"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_triggers_automation_id_key" ON "automation_triggers"("automation_id");

-- CreateIndex
CREATE INDEX "automation_events_organization_id_event_type_created_at_idx" ON "automation_events"("organization_id", "event_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_events_organization_id_event_key_key" ON "automation_events"("organization_id", "event_key");

-- CreateIndex
CREATE INDEX "automation_runs_organization_id_automation_id_created_at_idx" ON "automation_runs"("organization_id", "automation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_organization_id_dedup_key_key" ON "automation_runs"("organization_id", "dedup_key");

-- CreateIndex
CREATE INDEX "automation_step_runs_run_id_sequence_idx" ON "automation_step_runs"("run_id", "sequence");

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_source_event_id_fkey" FOREIGN KEY ("source_event_id") REFERENCES "automation_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_step_runs" ADD CONSTRAINT "automation_step_runs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "automation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Note: `prisma migrate dev` also proposed renaming a long, Postgres-truncated
-- index name on action_execution_events (unrelated pre-existing quirk, not
-- touched by this migration — same reasoning as the note at the top of this
-- file).
