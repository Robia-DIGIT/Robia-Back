-- RC-42: tenant-scoped WordPress credentials plus immutable draft approvals
-- and durable, fail-closed publication attempts.
CREATE TABLE "wordpress_connections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "website_id" TEXT NOT NULL,
    "site_url" TEXT NOT NULL,
    "api_base_url" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "encrypted_application_password" TEXT,
    "remote_user_id" TEXT,
    "remote_user_name" TEXT,
    "can_create_posts" BOOLEAN NOT NULL DEFAULT false,
    "can_create_pages" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "connection_version" INTEGER NOT NULL DEFAULT 1,
    "last_verified_at" TIMESTAMP(3),
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wordpress_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wordpress_draft_approvals" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "action_item_id" TEXT NOT NULL,
    "approved_by_id" TEXT NOT NULL,
    "document_revision" INTEGER NOT NULL,
    "content_digest" TEXT NOT NULL,
    "post_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "connection_version" INTEGER NOT NULL,
    "operation_key" TEXT NOT NULL,
    "canonical_payload" JSONB NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wordpress_draft_approvals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wordpress_draft_attempts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "approval_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "action_item_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "operation_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_flight',
    "claim_token" TEXT,
    "claimed_at" TIMESTAMP(3),
    "remote_post_id" TEXT,
    "remote_url" TEXT,
    "remote_editor_url" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "wordpress_draft_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wordpress_connections_website_id_key" ON "wordpress_connections"("website_id");
CREATE UNIQUE INDEX "wordpress_connections_organization_id_website_id_key" ON "wordpress_connections"("organization_id", "website_id");
CREATE INDEX "wordpress_connections_organization_id_status_idx" ON "wordpress_connections"("organization_id", "status");
CREATE UNIQUE INDEX "wordpress_draft_approvals_operation_key_key" ON "wordpress_draft_approvals"("operation_key");
CREATE INDEX "wordpress_draft_approvals_organization_id_document_id_created_at_idx" ON "wordpress_draft_approvals"("organization_id", "document_id", "created_at");
CREATE INDEX "wordpress_draft_approvals_organization_id_action_item_id_idx" ON "wordpress_draft_approvals"("organization_id", "action_item_id");
CREATE UNIQUE INDEX "wordpress_draft_attempts_approval_id_key" ON "wordpress_draft_attempts"("approval_id");
CREATE UNIQUE INDEX "wordpress_draft_attempts_operation_key_key" ON "wordpress_draft_attempts"("operation_key");
CREATE UNIQUE INDEX "wordpress_draft_attempts_organization_id_idempotency_key_key" ON "wordpress_draft_attempts"("organization_id", "idempotency_key");
CREATE INDEX "wordpress_draft_attempts_organization_id_status_updated_at_idx" ON "wordpress_draft_attempts"("organization_id", "status", "updated_at");

ALTER TABLE "wordpress_connections" ADD CONSTRAINT "wordpress_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wordpress_connections" ADD CONSTRAINT "wordpress_connections_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wordpress_draft_approvals" ADD CONSTRAINT "wordpress_draft_approvals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wordpress_draft_approvals" ADD CONSTRAINT "wordpress_draft_approvals_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "wordpress_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wordpress_draft_approvals" ADD CONSTRAINT "wordpress_draft_approvals_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wordpress_draft_approvals" ADD CONSTRAINT "wordpress_draft_approvals_action_item_id_fkey" FOREIGN KEY ("action_item_id") REFERENCES "action_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wordpress_draft_approvals" ADD CONSTRAINT "wordpress_draft_approvals_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wordpress_draft_attempts" ADD CONSTRAINT "wordpress_draft_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wordpress_draft_attempts" ADD CONSTRAINT "wordpress_draft_attempts_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "wordpress_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wordpress_draft_attempts" ADD CONSTRAINT "wordpress_draft_attempts_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "wordpress_draft_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wordpress_draft_attempts" ADD CONSTRAINT "wordpress_draft_attempts_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wordpress_draft_attempts" ADD CONSTRAINT "wordpress_draft_attempts_action_item_id_fkey" FOREIGN KEY ("action_item_id") REFERENCES "action_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
