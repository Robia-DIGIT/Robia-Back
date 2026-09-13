-- RC14 Assisted Execution: approval workflow, execution evidence, and append-only history.
ALTER TABLE "action_items"
ADD COLUMN "approval_status" TEXT NOT NULL DEFAULT 'draft',
ADD COLUMN "approval_reason" TEXT,
ADD COLUMN "execution_status" TEXT NOT NULL DEFAULT 'not_started',
ADD COLUMN "execution_evidence" JSONB,
ADD COLUMN "verification_audit_id" TEXT,
ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "action_execution_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "action_item_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_execution_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "action_execution_events_idempotency_key_key" ON "action_execution_events"("idempotency_key");
CREATE INDEX "action_execution_events_organization_id_action_item_id_created_at_idx" ON "action_execution_events"("organization_id", "action_item_id", "created_at");

ALTER TABLE "action_execution_events"
ADD CONSTRAINT "action_execution_events_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "action_execution_events"
ADD CONSTRAINT "action_execution_events_action_item_id_fkey"
FOREIGN KEY ("action_item_id") REFERENCES "action_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
