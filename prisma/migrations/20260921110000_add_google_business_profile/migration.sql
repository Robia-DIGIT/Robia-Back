ALTER TABLE "locations" ADD COLUMN "phone" TEXT;

CREATE TABLE "google_business_profile_connections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "google_account_email" TEXT,
    "encrypted_refresh_token" TEXT NOT NULL,
    "granted_scopes" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "google_business_profile_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "google_business_profile_locations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "google_account_name" TEXT NOT NULL,
    "account_display_name" TEXT,
    "google_location_name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "store_code" TEXT,
    "address" JSONB,
    "primary_phone" TEXT,
    "website_uri" TEXT,
    "primary_category" TEXT,
    "metadata" JSONB,
    "robia_location_id" TEXT,
    "last_synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "google_business_profile_locations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "google_business_profile_connections_organization_id_key" ON "google_business_profile_connections"("organization_id");
CREATE UNIQUE INDEX "google_business_profile_locations_connection_id_google_location_name_key" ON "google_business_profile_locations"("connection_id", "google_location_name");
CREATE INDEX "google_business_profile_locations_organization_id_last_synced_at_idx" ON "google_business_profile_locations"("organization_id", "last_synced_at");
CREATE INDEX "google_business_profile_locations_robia_location_id_idx" ON "google_business_profile_locations"("robia_location_id");

ALTER TABLE "google_business_profile_connections" ADD CONSTRAINT "google_business_profile_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "google_business_profile_locations" ADD CONSTRAINT "google_business_profile_locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "google_business_profile_locations" ADD CONSTRAINT "google_business_profile_locations_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "google_business_profile_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "google_business_profile_locations" ADD CONSTRAINT "google_business_profile_locations_robia_location_id_fkey" FOREIGN KEY ("robia_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
