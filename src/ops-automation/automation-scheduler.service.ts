import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationsService } from './automations.service';
import { computeNextOccurrence } from './cron-schedule';
import { redactSensitive } from '../common/logging/redact';
import { AutomationWithTrigger } from './automation.types';

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

    for (const automation of due) {
      try {
        await this.processDueAutomation(automation, now, staleLeaseThreshold);
      } catch (error) {
        // One automation's failure — a bad cron expression that somehow got
        // persisted, a transient DB error, anything — must never stop the
        // rest of this tick from being processed.
        this.logger.warn(
          `Scheduler : échec du traitement de l'automation ${automation.id} (organization=${automation.organizationId}) : ${
            redactSensitive(
              error instanceof Error ? error.message : 'erreur inconnue',
            ) as string
          }`,
        );
      }
    }
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
    // automation could have been disabled, deleted, or had its trigger
    // changed in the instant between the claim above and this read.
    // triggerScheduled() must only ever run against current state, never
    // the (possibly stale) snapshot from the outer findMany().
    const fresh = await this.prisma.automation.findFirst({
      where: { id: automation.id },
      include: { trigger: true },
    });
    if (
      !fresh ||
      !fresh.enabled ||
      !fresh.trigger ||
      fresh.trigger.type !== 'scheduled' ||
      !fresh.trigger.cronExpression
    ) {
      // No longer eligible: release the lease without touching nextRunAt.
      // Safe to key only on scheduledClaimedAt === now — nothing else can
      // hold or reclaim the lease while it is this fresh.
      await this.prisma.automation.updateMany({
        where: { id: automation.id, scheduledClaimedAt: now },
        data: { scheduledClaimedAt: null },
      });
      return;
    }

    // Phase 3 — execute via RC-20's engine, unchanged. If this throws (the
    // run genuinely could not be created — see class doc), nextRunAt is
    // deliberately left untouched below: the occurrence is retried once the
    // lease goes stale, never advanced past without a durably created run.
    await this.automations.triggerScheduled(fresh, scheduledFor);

    // Phase 4 — only reached once triggerScheduled() has resolved, i.e. the
    // run has been durably created. Anchored at `now` (this tick's instant),
    // never incremented from `scheduledFor`: however overdue this occurrence
    // was, the next value jumps straight to the next future occurrence
    // instead of replaying a backlog.
    const following = computeNextOccurrence(
      fresh.trigger.cronExpression,
      fresh.trigger.timezone,
      now,
    );
    await this.prisma.automation.updateMany({
      where: { id: automation.id, nextRunAt: scheduledFor },
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
        const next = computeNextOccurrence(
          trigger.cronExpression,
          trigger.timezone,
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
