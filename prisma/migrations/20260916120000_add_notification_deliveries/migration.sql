-- RC-26: Notification Delivery Foundation. Additive — a brand-new table,
-- nullable FKs to automation_runs/automation_step_runs (SET NULL on delete
-- so a delivery's history outlives the run/step it originated from).

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "recipient_user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "template_key" TEXT NOT NULL,
    "template_data" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "idempotency_key" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "provider_message_id" TEXT,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "automation_run_id" TEXT,
    "automation_step_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_organization_id_idempotency_key_key" ON "notification_deliveries"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_next_attempt_at_idx" ON "notification_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notification_deliveries_organization_id_created_at_idx" ON "notification_deliveries"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_automation_run_id_fkey" FOREIGN KEY ("automation_run_id") REFERENCES "automation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_automation_step_run_id_fkey" FOREIGN KEY ("automation_step_run_id") REFERENCES "automation_step_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
