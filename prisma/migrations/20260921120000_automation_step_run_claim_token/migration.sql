-- RC-27 hardening — an opaque per-attempt claim token, set alongside
-- claimed_at on every attempt (first synchronous one included, no longer
-- left null). Every conditional "do I still own this claim" check gates on
-- this column matching, never on claimed_at's timestamp value alone.
-- Additive, nullable.

-- AlterTable
ALTER TABLE "automation_step_runs" ADD COLUMN "claim_token" TEXT;
