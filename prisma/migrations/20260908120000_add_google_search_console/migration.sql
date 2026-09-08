CREATE TABLE "google_search_console_connections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "google_account_email" TEXT,
    "encrypted_refresh_token" TEXT NOT NULL,
    "selected_site_url" TEXT,
    "permission_level" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "google_search_console_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "google_search_console_daily_metrics" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "clicks" DOUBLE PRECISION NOT NULL,
    "impressions" DOUBLE PRECISION NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "google_search_console_daily_metrics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "google_search_console_connections_organization_id_key"
ON "google_search_console_connections"("organization_id");

CREATE UNIQUE INDEX "google_search_console_daily_metrics_connection_id_date_key"
ON "google_search_console_daily_metrics"("connection_id", "date");

CREATE INDEX "google_search_console_daily_metrics_connection_id_date_idx"
ON "google_search_console_daily_metrics"("connection_id", "date");

ALTER TABLE "google_search_console_connections"
ADD CONSTRAINT "google_search_console_connections_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "google_search_console_daily_metrics"
ADD CONSTRAINT "google_search_console_daily_metrics_connection_id_fkey"
FOREIGN KEY ("connection_id") REFERENCES "google_search_console_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
