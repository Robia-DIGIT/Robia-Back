import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { redactSensitive } from '../common/logging/redact';
import { AutomationsService } from './automations.service';
import {
  STEP_RETRY_CLAIM_LEASE_MS,
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
  async runDueRetries(now: Date): Promise<void> {
    const staleThreshold = new Date(now.getTime() - STEP_RETRY_CLAIM_LEASE_MS);
    const due = await this.prisma.automationStepRun.findMany({
      where: dueStepRetryWhere(now, staleThreshold),
    });

    for (const stepRun of due) {
      try {
        await this.automations.retryStep(stepRun.id, now);
      } catch (error) {
        // One step's retry failing must never stop the rest of this tick.
        this.logger.warn(
          `Automation step retry dispatcher : échec du traitement du step ${stepRun.id} (run=${stepRun.runId}) : ${
            redactSensitive(
              error instanceof Error ? error.message : 'erreur inconnue',
            ) as string
          }`,
        );
      }
    }
  }
}
