-- RC18: Meta/Facebook/Instagram read-only connection per organization.
CREATE TABLE "meta_connections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "meta_user_id" TEXT,
    "meta_user_name" TEXT,
    "encrypted_user_access_token" TEXT NOT NULL,
    "granted_scopes" TEXT,
    "selected_page_id" TEXT,
    "selected_page_name" TEXT,
    "encrypted_page_access_token" TEXT,
    "selected_instagram_account_id" TEXT,
    "selected_instagram_username" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meta_connections_organization_id_key"
ON "meta_connections"("organization_id");

ALTER TABLE "meta_connections"
ADD CONSTRAINT "meta_connections_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
