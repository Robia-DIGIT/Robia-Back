/*
  Warnings:

  - The `source_data` column on the `opportunities` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "opportunities" DROP COLUMN "source_data",
ADD COLUMN     "source_data" JSONB;

-- CreateTable
CREATE TABLE "web_pages" (
    "id" TEXT NOT NULL,
    "website_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "path" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "http_status" INTEGER,
    "title" TEXT,
    "meta_description" TEXT,
    "h1" JSONB,
    "h2" JSONB,
    "h3" JSONB,
    "canonical" TEXT,
    "meta_robots" TEXT,
    "word_count" INTEGER,
    "images_count" INTEGER,
    "images_without_alt" INTEGER,
    "internal_links_count" INTEGER,
    "external_links_count" INTEGER,
    "structured_data_types" JSONB,
    "og_tags_present" JSONB,
    "top_keywords" JSONB,
    "business_address" TEXT,
    "business_latitude" DOUBLE PRECISION,
    "business_longitude" DOUBLE PRECISION,
    "social_links" JSONB,
    "js_rendering_used" BOOLEAN NOT NULL DEFAULT false,
    "js_rendering_suspected" BOOLEAN NOT NULL DEFAULT false,
    "main_content" TEXT,
    "error_message" TEXT,
    "crawled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "web_pages_website_id_idx" ON "web_pages"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "web_pages_website_id_url_key" ON "web_pages"("website_id", "url");

-- AddForeignKey
ALTER TABLE "web_pages" ADD CONSTRAINT "web_pages_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
