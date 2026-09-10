ALTER TABLE "google_search_console_connections"
  ADD COLUMN "granted_scopes" TEXT,
  ADD COLUMN "selected_analytics_property_id" TEXT,
  ADD COLUMN "selected_analytics_property_name" TEXT,
  ADD COLUMN "last_analytics_synced_at" TIMESTAMP(3);
