/*
  Warnings:

  - A unique constraint covering the columns `[organization_id,url]` on the table `websites` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "websites_organization_id_url_key" ON "websites"("organization_id", "url");
