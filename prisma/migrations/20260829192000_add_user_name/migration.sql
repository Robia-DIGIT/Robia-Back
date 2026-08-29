-- Add the required name field while preserving existing users.
ALTER TABLE "users" ADD COLUMN "name" TEXT;

UPDATE "users"
SET "name" = split_part("email", '@', 1)
WHERE "name" IS NULL;

ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL;
