-- RC-25 hardening: the persisted timezone invariant is now enforced
-- strictly by trigger type — `scheduled` always carries a non-null IANA
-- zone (UTC by default), `event`/`manual` always carry null, and a
-- trigger's timezone is never silently reused across a type change.
--
-- The column was previously NOT NULL DEFAULT 'UTC' for every trigger type,
-- including event/manual — that default is exactly what let a residual
-- 'UTC' value survive a scheduled -> event/manual transition undetected.
-- Make it nullable, drop the DB-level default (the application now decides
-- the value explicitly per type), then null out every existing
-- non-scheduled row's timezone so historical data matches the invariant
-- going forward.

-- AlterTable
ALTER TABLE "automation_triggers" ALTER COLUMN "timezone" DROP NOT NULL;
ALTER TABLE "automation_triggers" ALTER COLUMN "timezone" DROP DEFAULT;

-- Data fix-up
UPDATE "automation_triggers" SET "timezone" = NULL WHERE "type" <> 'scheduled';
