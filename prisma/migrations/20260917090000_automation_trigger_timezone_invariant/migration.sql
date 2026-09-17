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

-- CHECK constraint (Codex review fix): the invariant above was, until now,
-- only ever enforced by AutomationsService.resolveTriggerTimezone() at the
-- application layer — a direct write (a manual SQL fix, a future migration,
-- a bug in code that bypasses that one method) could silently violate it.
-- Enforced at the database level too, as the actual source of truth: a
-- `scheduled` trigger's timezone can never be NULL, and a non-`scheduled`
-- trigger's timezone can never be non-NULL. Added after the backfill above,
-- never before — a CHECK is validated against every existing row at
-- creation time, so it must not run until the data it validates has already
-- been made to conform.
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_timezone_by_type_check"
  CHECK (
    ("type" = 'scheduled' AND "timezone" IS NOT NULL)
    OR
    ("type" <> 'scheduled' AND "timezone" IS NULL)
  );
