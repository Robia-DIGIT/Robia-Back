-- RC-38 "fiche complète" — the rest of what Google's Business Information API
-- returns for a location, so the frontend can show a complete listing
-- instead of the original partial read (title/category/address/phone only).
-- All additive and nullable/empty-default — no backfill needed, the next
-- sync populates every row.

ALTER TABLE "google_business_profile_locations" ADD COLUMN "language_code" TEXT;
ALTER TABLE "google_business_profile_locations" ADD COLUMN "additional_phones" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "google_business_profile_locations" ADD COLUMN "additional_categories" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "google_business_profile_locations" ADD COLUMN "description" TEXT;
ALTER TABLE "google_business_profile_locations" ADD COLUMN "regular_hours" JSONB;
ALTER TABLE "google_business_profile_locations" ADD COLUMN "special_hours" JSONB;
ALTER TABLE "google_business_profile_locations" ADD COLUMN "more_hours" JSONB;
ALTER TABLE "google_business_profile_locations" ADD COLUMN "service_area" JSONB;
ALTER TABLE "google_business_profile_locations" ADD COLUMN "labels" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "google_business_profile_locations" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "google_business_profile_locations" ADD COLUMN "longitude" DOUBLE PRECISION;
ALTER TABLE "google_business_profile_locations" ADD COLUMN "open_status" TEXT;
