CREATE TABLE "google_business_profile_reviews" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "google_review_name" TEXT NOT NULL,
    "reviewer_display_name" TEXT,
    "reviewer_photo_uri" TEXT,
    "star_rating" INTEGER,
    "comment" TEXT,
    "create_time" TIMESTAMP(3),
    "update_time" TIMESTAMP(3),
    "reply_comment" TEXT,
    "reply_update_time" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "google_business_profile_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "google_business_profile_reviews_location_id_google_review_name_key" ON "google_business_profile_reviews"("location_id", "google_review_name");
CREATE INDEX "google_business_profile_reviews_organization_id_location_id_idx" ON "google_business_profile_reviews"("organization_id", "location_id");

ALTER TABLE "google_business_profile_reviews" ADD CONSTRAINT "google_business_profile_reviews_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "google_business_profile_reviews" ADD CONSTRAINT "google_business_profile_reviews_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "google_business_profile_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
