import { HttpException } from '@nestjs/common';
import {
  InvalidOpsActionInputError,
  UnknownOpsActionError,
} from './actions/ops-actions-registry.service';

// RC-27 — automatic step-level retries. A step that fails with a transient
// error is retried automatically, with backoff, instead of failing the
// whole run on the very first attempt — but only when retrying could
// plausibly change the outcome (see isPermanentStepError() below).
//
// "1 initial attempt + 3 retries" — 1 min, 5 min, 30 min — mirrors RC-26's
// NotificationDispatcherService cadence for its first three tiers (the same
// two-phase claim-with-lease design is reused here, see
// AutomationStepRetryDispatcherService), but shorter overall: a step
// failure is almost always an internal-service or short-lived network
// blip, not a third-party provider outage, so there is little value in
// RC-26's longer 2h/12h tail here.
export const MAX_STEP_ATTEMPTS = 4;
export const STEP_RETRY_BACKOFF_MS = [
  60_000, // 1 min — after attempt 1 fails
  5 * 60_000, // 5 min — after attempt 2 fails
  30 * 60_000, // 30 min — after attempt 3 fails (attempt 4 is final)
];

// How long a claim lease (AutomationStepRun.claimedAt) is honored before
// another dispatcher instance may reclaim the same due retry — same
// crash-safety duration as RC-25's AutomationSchedulerService and RC-26's
// NotificationDispatcherService.
export const STEP_RETRY_CLAIM_LEASE_MS = 5 * 60 * 1000;

// Classifies a step execution failure. Two disjoint outcomes:
//
// - Permanent (never worth retrying, because the *input itself* — frozen in
//   plannedSteps at trigger time, see AutomationsService.startRun() — is
//   what's wrong, not transient infrastructure):
//   UnknownOpsActionError/InvalidOpsActionInputError (the two error classes
//   OpsActionsRegistryService itself throws for a malformed/unresolvable
//   input), and any HttpException with a 4xx status — the same
//   "client error" signal AuditsService/OpportunitiesService/
//   NotificationsService/ActionItemsService already throw throughout this
//   codebase for "not found"/"bad request"/"forbidden"/"conflict" (e.g. a
//   websiteId that no longer belongs to this organization). Retrying an
//   identical input against identical database state four times over half
//   an hour cannot fix a 404.
// - Retryable (the default for everything else, including a plain Error, a
//   network timeout, or an HttpException with a 5xx/no status): the same
//   "an unknown failure is never assumed permanent" discipline
//   NotificationDispatcherService already applies to
//   PermanentNotificationDeliveryError vs. everything else.
//
// Never called for the "action type not in the allowlist" check — that path
// never even creates a 'running' attempt (see runStepsFrom()) and always
// fails the run outright, retry policy aside.
export function isPermanentStepError(error: unknown): boolean {
  if (
    error instanceof InvalidOpsActionInputError ||
    error instanceof UnknownOpsActionError
  ) {
    return true;
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status >= 400 && status < 500;
  }
  return false;
}

// Matches a 'retry_scheduled' AutomationStepRun whose nextAttemptAt is due,
// or a 'running' one whose retry claim lease has gone stale (some instance
// claimed a retry and crashed before finishing it) — in both cases only
// while the claim lease is free or stale. `claimedAt: { not: null }` on the
// 'running' branch is deliberate and required: unlike RC-26's
// NotificationDelivery (where every attempt, including the first, goes
// through the claim mechanism), an AutomationStepRun's very first attempt
// runs synchronously inside AutomationsService.runStepsFrom() and is never
// claimed (claimedAt stays null) — without this, a step legitimately
// executing its first attempt right now would look identical to an
// abandoned retry and could be "reclaimed" out from under it.
//
// Shared between AutomationStepRetryDispatcherService's own due-set scan and
// AutomationsService.retryStep()'s claim UPDATE, so both always agree on
// exactly what counts as due — see NotificationDispatcherService.dueSetWhere()
// for the identical rationale.
export function dueStepRetryWhere(now: Date, staleThreshold: Date) {
  return {
    AND: [
      {
        OR: [
          { status: 'retry_scheduled', nextAttemptAt: { lte: now } },
          { status: 'running', claimedAt: { not: null } },
        ],
      },
      { OR: [{ claimedAt: null }, { claimedAt: { lt: staleThreshold } }] },
    ],
  };
}
