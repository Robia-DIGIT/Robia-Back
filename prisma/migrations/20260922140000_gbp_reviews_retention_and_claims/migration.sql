-- RC-40 fix — Google Business Profile data-retention compliance + claim/lease
-- concurrency control.
--
-- Google's GBP API terms cap third-party storage of API-sourced content at
-- 30 days and forbid manipulating/aggregating stored content. This
-- migration:
--   1. Drops "reviewer_photo_uri" (never used by the frontend, no reason to
--      retain it).
--   2. Adds a per-review "expires_at" column, backfilled to 24h after each
--      row's existing "last_synced_at" (this repo's chosen freshness
--      target, strictly under Google's 30-day ceiling). Every read path
--      filters on this column so an expired review is never served even if
--      the scheduled purge cron hasn't run yet.
--   3. Adds atomic claim/lease state for the per-location reviews sync
--      (same claim-token pattern as automation_step_runs.claim_token /
--      AutomationSchedulerService), plus Google's own aggregate
--      averageRating/totalReviewCount cached alongside the reviews cache
--      expiry so both expire on the same schedule and are never recomputed
--      from stored reviews.
--   4. Adds the same claim/lease columns for the Performance API read path,
--      for server-side quota protection independent of the frontend.

-- AlterTable
ALTER TABLE "google_business_profile_reviews" DROP COLUMN "reviewer_photo_uri";
ALTER TABLE "google_business_profile_reviews" ADD COLUMN "expires_at" TIMESTAMP(3);
UPDATE "google_business_profile_reviews" SET "expires_at" = "last_synced_at" + INTERVAL '24 hours' WHERE "expires_at" IS NULL;
ALTER TABLE "google_business_profile_reviews" ALTER COLUMN "expires_at" SET NOT NULL;

CREATE INDEX "google_business_profile_reviews_expires_at_idx" ON "google_business_profile_reviews"("expires_at");
CREATE INDEX "google_business_profile_reviews_last_synced_at_idx" ON "google_business_profile_reviews"("last_synced_at");

-- AlterTable
ALTER TABLE "google_business_profile_locations"
  ADD COLUMN "reviews_sync_claimed_at" TIMESTAMP(3),
  ADD COLUMN "reviews_sync_claim_token" TEXT,
  ADD COLUMN "reviews_last_sync_attempt_at" TIMESTAMP(3),
  ADD COLUMN "reviews_last_synced_at" TIMESTAMP(3),
  ADD COLUMN "reviews_sync_status" TEXT NOT NULL DEFAULT 'never',
  ADD COLUMN "reviews_average_rating" DOUBLE PRECISION,
  ADD COLUMN "reviews_total_review_count" INTEGER,
  ADD COLUMN "reviews_cache_expires_at" TIMESTAMP(3),
  ADD COLUMN "performance_claimed_at" TIMESTAMP(3),
  ADD COLUMN "performance_claim_token" TEXT,
  ADD COLUMN "performance_last_attempt_at" TIMESTAMP(3);
