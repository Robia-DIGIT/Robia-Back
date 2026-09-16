-- RC-25: scheduled triggers need an explicit IANA timezone to evaluate
-- their cron expression in — never inferred from the organization's
-- city/country. Additive, defaulted column: existing rows (all currently
-- manual/event triggers, since nothing consumed cronExpression before
-- RC-25) become "UTC", which is a safe, inert default for a trigger type
-- that isn't scheduled anyway.

-- AlterTable
ALTER TABLE "automation_triggers" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';
