import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationsService } from './automations.service';
import { computeNextOccurrence } from './cron-schedule';
import { redactSensitive } from '../common/logging/redact';
import { AutomationWithTrigger } from './automation.types';
import {
  SCHEDULER_MAX_BATCH_SIZE,
  SCHEDULER_MAX_CONCURRENCY,
} from './automation.constants';

// How long a claim lease is honored before another dispatcher instance may
// reclaim the same occurrence. Must comfortably exceed how long a single
// triggerScheduled() call can realistically take; if the claiming instance
// crashed mid-flight, the occurrence is only delayed by up to this long —
// never lost, since nextRunAt itself is not advanced until after the run
// has been durably created (see processDueAutomation()).
const SCHEDULED_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * RC-25 — the single periodic tick that turns a `scheduled` trigger's
 * stored `nextRunAt` into a real run via AutomationsService, closing the
 * gap RC-20 left open: `Automation.trigger.cronExpression` and
 * `Automation.nextRunAt` were always stored but never read by anything.
 *
 * One dispatcher, not one job per automation: the set of automations is
 * dynamic (created/edited/enabled by users at any time), so a single
 * periodic scan avoids ever having to register/unregister a per-automation
 * job with SchedulerRegistry.
 *
 * Concurrency and crash-safety — two-phase claim (RC-25 review fix):
 *
 * 1. Claim: a conditional UPDATE sets `scheduledClaimedAt = now` on the
 *    row, keyed on `id` + the exact `nextRunAt` observed + `enabled: true`
 *    + the lease being free (null or stale). This both picks a single
 *    winner among concurrent dispatcher instances/ticks (Postgres
 *    serializes concurrent UPDATEs on the same row — the loser's WHERE
 *    stops matching) AND closes the disable/modify race: a disable that
 *    lands between the outer findMany() read and this UPDATE makes the
 *    `enabled: true` clause fail to match, so the claim itself fails.
 * 2. Re-fetch: after winning the claim, the automation is read fresh —
 *    catching a disable/trigger-type change that lands in the (much
 *    smaller) gap between the claim and this read. If no longer eligible,
 *    the lease is released and nothing executes.
 * 3. Execute: AutomationsService.triggerScheduled() — RC-20's engine,
 *    unchanged. AutomationRun's own `(organizationId, dedupKey)` unique
 *    constraint remains a second, independent layer.
 * 4. Advance: `nextRunAt` is only ever moved forward — and the lease
 *    released — AFTER triggerScheduled() has resolved successfully, i.e.
 *    after the run has been durably created. If the process crashes
 *    anywhere before that (or triggerScheduled() throws because the run
 *    genuinely couldn't be created — a loop-depth guard, an active-run
 *    conflict, an unexpected DB error), `nextRunAt` is left untouched: the
 *    occurrence is simply retried, by this or another instance, once the
 *    lease goes stale — never silently lost, never replayed as a burst
 *    (the recomputed value is always anchored at the tick's `now`, never
 *    incremented from `scheduledFor`).
 *
 * Bounded concurrency within a tick (RC-25 hardening fix): the due-set is
 * sorted oldest-`nextRunAt`-first (id as a deterministic tie-breaker), the
 * first `SCHEDULER_MAX_BATCH_SIZE` are taken as this tick's batch — anything
 * beyond that waits for the next tick, its own nextRunAt untouched, exactly
 * like an occurrence that lost the claim race — and the batch is worked by
 * up to `SCHEDULER_MAX_CONCURRENCY` automations at a time, never all of it
 * as one unbounded `Promise.allSettled`. Each automation's own Phase 1-4
 * claim/re-fetch/execute/advance above is entirely independent per row, so
 * running several concurrently introduces no new hazard: the same
 * Postgres-serialized CAS that makes two dispatcher *instances* safe (see
 * above) equally makes two automations processed *concurrently by one
 * instance* safe. One automation's failure is caught right where it always
 * was, per automation, so it can never stop its concurrent siblings, let
 * alone the rest of the batch.
 *
 * See docs/RC25_SCHEDULED_AUTOMATIONS.md for the full reasoning.
 */
@Injectable()
export class AutomationSchedulerService {
  private readonly logger = new Logger(AutomationSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly automations: AutomationsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick(): Promise<void> {
    await this.runDueAutomations(new Date());
  }

  // Split from handleTick() so tests can drive it directly with a
  // controlled `now` instead of waiting on a real clock or mocking
  // @nestjs/schedule's decorator machinery.
  async runDueAutomations(now: Date): Promise<void> {
    await this.reconcileMissingNextRunAt(now);

    const staleLeaseThreshold = new Date(
      now.getTime() - SCHEDULED_CLAIM_LEASE_MS,
    );
    const due = await this.prisma.automation.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now },
        trigger: { type: 'scheduled' },
        OR: [
          { scheduledClaimedAt: null },
          { scheduledClaimedAt: { lt: staleLeaseThreshold } },
        ],
      },
      include: { trigger: true },
    });

    // Deterministic order — oldest due occurrence first, id as a stable
    // tie-breaker — so which automations make this tick's bounded batch,
    // and in what order they're attempted, never depends on the DB's own
    // unspecified row order.
    const ordered = [...due].sort((a, b) => {
      const at = a.nextRunAt?.getTime() ?? 0;
      const bt = b.nextRunAt?.getTime() ?? 0;
      if (at !== bt) return at - bt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    // Bounded batch: whatever doesn't fit is left for the next tick, in the
    // same oldest-first order — see the class doc's "Bounded concurrency".
    const batch = ordered.slice(0, SCHEDULER_MAX_BATCH_SIZE);

    await this.runWithBoundedConcurrency(
      batch,
      SCHEDULER_MAX_CONCURRENCY,
      async (automation) => {
        try {
          await this.processDueAutomation(automation, now, staleLeaseThreshold);
        } catch (error) {
          // One automation's failure — a bad cron expression that somehow
          // got persisted, a transient DB error, anything — must never stop
          // its concurrent siblings, let alone the rest of this tick.
          this.logger.warn(
            `Scheduler : échec du traitement de l'automation ${automation.id} (organization=${automation.organizationId}) : ${
              redactSensitive(
                error instanceof Error ? error.message : 'erreur inconnue',
              ) as string
            }`,
          );
        }
      },
    );
  }

  // A minimal worker-pool: up to `concurrency` calls to `worker` in flight
  // at any time, each pulling the next item off `items` as soon as it's
  // free — never all of `items` launched at once (unbounded
  // `Promise.allSettled`) and never strictly one-at-a-time (a plain
  // sequential `for...await` loop, where one slow item delays every later
  // one). No new dependency: the whole primitive is this loop.
  private async runWithBoundedConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;
    const workerCount = Math.min(concurrency, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]);
      }
    });
    await Promise.all(workers);
  }

  private async processDueAutomation(
    automation: AutomationWithTrigger,
    now: Date,
    staleLeaseThreshold: Date,
  ): Promise<void> {
    const trigger = automation.trigger;
    if (!trigger || trigger.type !== 'scheduled' || !trigger.cronExpression) {
      // Can't happen given the query above at the instant it ran, but a row
      // can change between that read and this iteration — never trust the
      // read-then-act gap.
      return;
    }
    const scheduledFor = automation.nextRunAt;
    if (!scheduledFor) {
      return;
    }

    // Phase 1 — claim the lease. `enabled: true` is re-checked here (not
    // just in the outer findMany) so a disable landing in that gap still
    // makes the claim fail to match instead of silently succeeding.
    const claim = await this.prisma.automation.updateMany({
      where: {
        id: automation.id,
        nextRunAt: scheduledFor,
        enabled: true,
        OR: [
          { scheduledClaimedAt: null },
          { scheduledClaimedAt: { lt: staleLeaseThreshold } },
        ],
      },
      data: { scheduledClaimedAt: now },
    });
    if (claim.count === 0) {
      // Lost the race, or no longer eligible: another instance/tick already
      // holds the lease, or this automation was disabled/modified — either
      // way, this call does not own triggering the run.
      return;
    }

    // Phase 2 — re-fetch fresh state now that the lease is held: the
    // automation could have been disabled, deleted, had its trigger
    // changed, or had its schedule replaced (disable+re-enable,
    // cron/timezone edit) in the instant between the claim above and this
    // read. triggerScheduled() must only ever run against current state,
    // never the (possibly stale) snapshot from the outer findMany() — and
    // crucially, only ever against the exact occurrence this call actually
    // claimed, never a newer one that happens to share the row.
    //
    // Checking `enabled`/`trigger.type`/`cronExpression` alone is not
    // enough: a disable-then-re-enable (or a cron/timezone edit) between
    // the claim and this read leaves `enabled: true` and a valid trigger,
    // but AutomationsService.update()/setEnabled() will have rewritten
    // `nextRunAt` to a *different* occurrence and cleared
    // `scheduledClaimedAt` (see their RC-25 review fix comments) — so both
    // are re-checked here too. Any mismatch means the claim this call
    // thinks it holds is no longer the one on the row, so it must not
    // execute anything.
    const fresh = await this.prisma.automation.findFirst({
      where: { id: automation.id },
      include: { trigger: true },
    });
    if (
      !fresh ||
      !fresh.enabled ||
      !fresh.trigger ||
      fresh.trigger.type !== 'scheduled' ||
      !fresh.trigger.cronExpression ||
      fresh.nextRunAt === null ||
      fresh.nextRunAt.getTime() !== scheduledFor.getTime() ||
      fresh.scheduledClaimedAt === null ||
      fresh.scheduledClaimedAt.getTime() !== now.getTime()
    ) {
      // No longer eligible, or the claim was invalidated out from under
      // this call: release the lease without touching nextRunAt. Safe to
      // key only on scheduledClaimedAt === now — this no-ops if the claim
      // was already cleared (by an update()/setEnabled() call, or by
      // another instance), and never touches a claim held by anyone else.
      await this.prisma.automation.updateMany({
        where: { id: automation.id, scheduledClaimedAt: now },
        data: { scheduledClaimedAt: null },
      });
      return;
    }

    // Phase 3 — execute via RC-20's engine, unchanged. Past this point, the
    // claim held by this call is the linearization point: no other call —
    // this instance's or another's — can also reach here for the same
    // occurrence, since Phase 1/Phase 2 above have already excluded every
    // other path to it. If this throws (the run genuinely could not be
    // created — see class doc), nextRunAt is deliberately left untouched
    // below: the occurrence is retried once the lease goes stale, never
    // advanced past without a durably created run.
    await this.automations.triggerScheduled(fresh, scheduledFor);

    // Phase 4 — only reached once triggerScheduled() has resolved, i.e. the
    // run has been durably created. Anchored at `now` (this tick's instant),
    // never incremented from `scheduledFor`: however overdue this occurrence
    // was, the next value jumps straight to the next future occurrence
    // instead of replaying a backlog. `scheduledClaimedAt: now` is included
    // in the WHERE (not just `nextRunAt`) so a worker that was delayed long
    // enough for its lease to go stale — and whose claim was since reclaimed
    // by another instance — can never release or overwrite that other
    // instance's claim here, even in the rare case nextRunAt happens to
    // still read back the same value.
    // fresh.trigger.timezone is only ever null for an event/manual trigger
    // under the persisted invariant (see AutomationsService.
    // resolveTriggerTimezone()) — the check just above already guarantees
    // trigger.type === 'scheduled' here, so this fallback is purely
    // defensive against a broken invariant (corrupted data, a future bug),
    // never the expected path; it degrades to UTC rather than crashing the
    // whole tick, same posture as resolveNextRunAt's own degradation.
    const timezone = fresh.trigger.timezone ?? 'UTC';
    if (fresh.trigger.timezone === null) {
      this.logger.warn(
        `Scheduler : trigger scheduled sans timezone persistée pour l'automation ${automation.id} (organization=${automation.organizationId}) — repli sur UTC.`,
      );
    }
    const following = computeNextOccurrence(
      fresh.trigger.cronExpression,
      timezone,
      now,
    );
    await this.prisma.automation.updateMany({
      where: {
        id: automation.id,
        nextRunAt: scheduledFor,
        scheduledClaimedAt: now,
      },
      data: { nextRunAt: following, scheduledClaimedAt: null },
    });
  }

  // RC-25 review fix: an automation that was already enabled+scheduled
  // before RC25 shipped (or whose nextRunAt computation degraded to null at
  // write time — see AutomationsService.resolveNextRunAt) has
  // `enabled: true` and `trigger.type: 'scheduled'` but `nextRunAt: null`.
  // A `nextRunAt <= now` filter never matches NULL, so it would otherwise
  // never be picked up. This finds and initializes exactly that set, never
  // touching manual/event automations or ones that already have a
  // nextRunAt.
  private async reconcileMissingNextRunAt(now: Date): Promise<void> {
    const orphaned = await this.prisma.automation.findMany({
      where: {
        enabled: true,
        nextRunAt: null,
        trigger: { type: 'scheduled' },
      },
      include: { trigger: true },
    });

    for (const automation of orphaned) {
      const trigger = automation.trigger;
      if (!trigger || !trigger.cronExpression) {
        continue;
      }
      try {
        // Same defensive UTC fallback as processDueAutomation() above — see
        // its comment. trigger.type === 'scheduled' is already guaranteed
        // by the query above.
        const next = computeNextOccurrence(
          trigger.cronExpression,
          trigger.timezone ?? 'UTC',
          now,
        );
        // Concurrency-safe: only initializes while still null, so two
        // instances racing here can't both "win" and disagree on the first
        // occurrence — the loser's WHERE simply stops matching.
        await this.prisma.automation.updateMany({
          where: { id: automation.id, nextRunAt: null },
          data: { nextRunAt: next },
        });
      } catch (error) {
        this.logger.warn(
          `Scheduler : impossible d'initialiser nextRunAt pour l'automation ${automation.id} (organization=${automation.organizationId}) : ${
            redactSensitive(
              error instanceof Error ? error.message : 'erreur inconnue',
            ) as string
          }`,
        );
      }
    }
  }
}
