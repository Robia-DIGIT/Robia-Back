import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { AutomationStepRun } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { redactSensitive } from '../common/logging/redact';
import { AutomationsService } from './automations.service';
import {
  STEP_RETRY_CLAIM_LEASE_MS,
  STEP_RETRY_MAX_BATCH_SIZE,
  STEP_RETRY_MAX_CONCURRENCY,
  dueStepRetryWhere,
} from './step-retry-policy';

/**
 * RC-27 — the single periodic tick that turns a 'retry_scheduled'
 * AutomationStepRun back into a real attempt. Thin by design: this service
 * only finds due rows and hands each one to
 * AutomationsService.retryStep(), which owns the actual claim, re-fetch,
 * attempt, and outcome logic — the same split RC-25 draws between
 * AutomationSchedulerService (the tick) and AutomationsService.
 * triggerScheduled() (the engine).
 *
 * One dispatcher, not one job per step: the set of steps waiting on a retry
 * is dynamic, so a single periodic scan avoids ever having to
 * register/unregister a per-step job with SchedulerRegistry — the same
 * reasoning as RC-25's scheduler and RC-26's notification dispatcher.
 */
@Injectable()
export class AutomationStepRetryDispatcherService {
  private readonly logger = new Logger(
    AutomationStepRetryDispatcherService.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly automations: AutomationsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick(): Promise<void> {
    await this.runDueRetries(new Date());
  }

  // Split from handleTick() so tests can drive it directly with a
  // controlled `now` instead of waiting on a real clock.
  //
  // RC-27 hardening — orderBy + take are part of the query itself, not
  // applied afterwards in Node: however large the due-set has grown,
  // Postgres never returns more than STEP_RETRY_MAX_BATCH_SIZE rows,
  // oldest createdAt first (id as a deterministic tie-breaker for equal
  // timestamps — the same shape as RC-25's AutomationSchedulerService).
  // Whatever doesn't fit in this tick's `take` is simply picked up by the
  // next tick's own query a minute later — nothing is lost, only delayed.
  // Processing itself is bounded to STEP_RETRY_MAX_CONCURRENCY steps in
  // flight at once (never one unbounded `Promise.allSettled` over the
  // whole batch), and one step's own retry failing — a bad input, a
  // transient DB error — is caught and logged per-row, never allowed to
  // stop its concurrent siblings or the rest of this tick.
  async runDueRetries(now: Date): Promise<void> {
    const staleThreshold = new Date(now.getTime() - STEP_RETRY_CLAIM_LEASE_MS);
    const due = await this.prisma.automationStepRun.findMany({
      where: dueStepRetryWhere(now, staleThreshold),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: STEP_RETRY_MAX_BATCH_SIZE,
    });

    await this.runWithBoundedConcurrency(
      due,
      STEP_RETRY_MAX_CONCURRENCY,
      async (stepRun) => {
        try {
          await this.automations.retryStep(stepRun.id, now);
        } catch (error) {
          this.logger.warn(
            `Automation step retry dispatcher : échec du traitement du step ${stepRun.id} (run=${stepRun.runId}) : ${
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
  // free. Identical in shape to AutomationSchedulerService's own copy (see
  // that class's doc comment) — small enough, and specific enough to each
  // caller's own item type, that a shared cross-cutting abstraction isn't
  // worth it yet.
  private async runWithBoundedConcurrency(
    items: AutomationStepRun[],
    concurrency: number,
    worker: (item: AutomationStepRun) => Promise<void>,
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
}
