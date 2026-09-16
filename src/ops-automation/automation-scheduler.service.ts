import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationsService } from './automations.service';
import { computeNextOccurrence } from './cron-schedule';
import { AutomationWithTrigger } from './automation.types';

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
 * Concurrency: see runDueAutomations()/processDueAutomation() below and
 * docs/RC25_SCHEDULED_AUTOMATIONS.md for the full reasoning — in short, a
 * single conditional UPDATE (`automation.updateMany` keyed on the
 * automation's id *and* the exact `nextRunAt` value observed) is what
 * actually prevents two dispatcher instances — or two overlapping ticks —
 * from both triggering the same occurrence; AutomationRun's existing
 * `(organizationId, dedupKey)` unique constraint is the second, independent
 * layer (already proven out for the `event` trigger path).
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
    const due = await this.prisma.automation.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now },
        trigger: { type: 'scheduled' },
      },
      include: { trigger: true },
    });

    for (const automation of due) {
      try {
        await this.processDueAutomation(automation, now);
      } catch (error) {
        // One automation's failure — a bad cron expression that somehow
        // got persisted, a transient DB error, anything — must never stop
        // the rest of this tick from being processed.
        this.logger.warn(
          `Scheduler : échec du traitement de l'automation ${automation.id} (organization=${automation.organizationId}) : ${
            error instanceof Error ? error.message : 'erreur inconnue'
          }`,
        );
      }
    }
  }

  private async processDueAutomation(
    automation: AutomationWithTrigger,
    now: Date,
  ): Promise<void> {
    const trigger = automation.trigger;
    if (!trigger || trigger.type !== 'scheduled' || !trigger.cronExpression) {
      // Can't happen given the query above at the instant it ran, but a
      // row can change between that read and this iteration (e.g. another
      // request just disabled it or switched its trigger type) — never
      // trust the read-then-act gap.
      return;
    }
    const scheduledFor = automation.nextRunAt;
    if (!scheduledFor) {
      return;
    }

    // Anchored at `now`, never incremented from `scheduledFor`: however
    // overdue this occurrence is (a restart after downtime, a long
    // outage...), the next value always jumps straight to the next
    // *future* occurrence. That is what limits a catch-up to a single run
    // instead of replaying every missed occurrence in a burst.
    const following = computeNextOccurrence(
      trigger.cronExpression,
      trigger.timezone,
      now,
    );

    const claim = await this.prisma.automation.updateMany({
      where: { id: automation.id, nextRunAt: scheduledFor },
      data: { nextRunAt: following, lastRunAt: now },
    });
    if (claim.count === 0) {
      // Lost the race: another instance (or another tick) already claimed
      // this occurrence — its own call now owns triggering the run.
      return;
    }

    // Claimed but not yet run (e.g. a crash right here) is a known,
    // accepted gap: the occurrence is simply not retried, consistent with
    // "at most one catch-up run, never a burst" — see docs/RC25_....md.
    await this.automations.triggerScheduled(automation, scheduledFor);
  }
}
