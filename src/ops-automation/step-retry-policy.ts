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

// RC-27 hardening — same "bound the query itself, not just processing after
// an unbounded findMany()" fix RC-25's AutomationSchedulerService already
// applies to its own due-set scan (see that class's own doc comment).
export const STEP_RETRY_MAX_BATCH_SIZE = 50;
export const STEP_RETRY_MAX_CONCURRENCY = 5;

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

// RC-27 hardening — every AutomationStepRun attempt is now claimed,
// including the first (see AutomationsService.runStepsFrom(): claimedAt +
// claimToken are set at creation time, never left null). That first
// attempt runs synchronously, so a crash mid-attempt leaves a 'running' row
// whose claim lease eventually goes stale exactly like an abandoned retry
// claim would — this is deliberate: it is the mechanism that lets a first
// attempt's crash be recovered at all (see abandonedRunningClaimWhere()
// below), closing the gap the previous design's comment on this file
// documented as a known limitation ("never set for the initial synchronous
// attempt").
//
// Matches anything AutomationStepRetryDispatcherService's scan should hand
// to AutomationsService.retryStep() — either a 'retry_scheduled' row that's
// due, or a 'running' row whose claim lease has gone stale (first attempt
// or retry attempt, crashed either way — retryStep() itself tells the two
// apart, see dueScheduledRetryWhere()/abandonedRunningClaimWhere() below).
// Only a *scan* predicate: it decides what to look at, never what to claim
// — the two-phase split below is what's actually used for the atomic claim
// UPDATE, so a row can never be treated as "due" by one check and "claimed"
// under a different, disagreeing condition.
export function dueStepRetryWhere(now: Date, staleThreshold: Date) {
  return {
    OR: [
      { status: 'retry_scheduled' as const, nextAttemptAt: { lte: now } },
      { status: 'running' as const, claimedAt: { lt: staleThreshold } },
      legacyUnclaimedRunningWhere(staleThreshold),
    ],
  };
}

// A 'retry_scheduled' row whose nextAttemptAt is due. Reaching this status
// at all already required passing OpsActionsRegistryService.isRetrySafe()
// once (see AutomationsService.runStepsFrom()/retryStep() — a non-retry-safe
// action's transient failure fails the run outright instead of ever
// scheduling a retry), so a claim won under this predicate is always safe
// to actually re-attempt, no further check needed.
export function dueScheduledRetryWhere(now: Date) {
  return { status: 'retry_scheduled' as const, nextAttemptAt: { lte: now } };
}

// A 'running' row whose claim lease has gone stale — the previous
// claimant (a first attempt or a retry attempt) crashed or was killed
// before recording any outcome, so its true result is unknown. Reclaiming
// this is NOT automatically safe to re-attempt: the caller must check
// OpsActionsRegistryService.isRetrySafe() for this step's own actionType
// *after* winning the claim (only then is the actionType known) and refuse
// to re-execute a non-retry-safe action — see AutomationsService.retryStep().
export function abandonedRunningClaimWhere(staleThreshold: Date) {
  return { status: 'running' as const, claimedAt: { lt: staleThreshold } };
}

// Codex review — a first attempt created *before* RC27 shipped never had
// claimedAt/claimToken set at all (those columns did not exist as a
// concept yet), so a worker killed mid-attempt (e.g. a deploy) can leave
// such a row stuck at status='running' with claimedAt=null AND
// claimToken=null forever: abandonedRunningClaimWhere()'s own
// `claimedAt: { lt: staleThreshold }` can never match a null claimedAt
// (SQL NULL comparisons are never true), so neither the dispatcher's scan
// nor retryStep()'s own claim ever saw these rows before this predicate
// existed. `startedAt` — a column that *did* already exist pre-RC27 — is
// the only reliable staleness signal available for this shape, so this
// gates on it instead of claimedAt. Never matches a row with either claim
// column set (that's abandonedRunningClaimWhere()'s and
// dueScheduledRetryWhere()'s territory, handled by the normal — but
// unsafe-to-blindly-retry — reclaim path) or a recent one (startedAt not
// yet past the same lease duration everything else here uses). See
// AutomationsService.reconcileLegacyUnclaimedRunningStep(): a row matching
// this is never re-executed, only force-failed — its true outcome is
// permanently unknown, exactly like an abandoned claim's, just without
// the claim metadata to prove it via the usual mechanism.
export function legacyUnclaimedRunningWhere(staleThreshold: Date) {
  return {
    status: 'running' as const,
    claimedAt: null,
    claimToken: null,
    startedAt: { lt: staleThreshold },
  };
}
