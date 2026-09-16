import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationDelivery } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { redactSensitive } from '../common/logging/redact';
import { maskEmail } from './mask-email';
import { renderNotificationTemplate } from './notification-templates';
import {
  IncompleteSmtpConfigurationError,
  NOTIFICATION_TRANSPORT,
  NotificationsDisabledError,
  PermanentNotificationDeliveryError,
} from './notification-transport';
// Type-only: NotificationTransport is an interface (no runtime value), and
// it types a constructor parameter decorated with @Inject() below — with
// emitDecoratorMetadata on, TS requires such a type to be imported with
// `import type` rather than mixed into the value import above.
import type { NotificationTransport } from './notification-transport';

// How long a claim lease is honored before another dispatcher instance may
// reclaim it — the same crash-safety pattern as RC-25's
// AutomationSchedulerService.SCHEDULED_CLAIM_LEASE_MS, applied here to
// NotificationDelivery.claimedAt instead of Automation.scheduledClaimedAt.
const CLAIM_LEASE_MS = 5 * 60 * 1000;

// "Backoff : 1 min, 5 min, 30 min, 2 h, 12 h" with a hard cap of 5 attempts
// total: attempt #1 has no backoff (it fires as soon as it's due), so only
// 4 retries — and therefore only the first 4 backoff values — are ever
// actually scheduled before the 5th (final) attempt; if that one also
// fails, the delivery goes straight to dead_letter. The 5th value (12 h) is
// kept in this array for documentation/symmetry with the spec and as the
// value to use first if MAX_ATTEMPTS is ever raised — it is not reachable
// under the current cap.
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [
  60_000, // 1 min
  5 * 60_000, // 5 min
  30 * 60_000, // 30 min
  2 * 3_600_000, // 2 h
  12 * 3_600_000, // 12 h
];

/**
 * RC-26 — the single periodic tick that actually sends queued
 * NotificationDelivery rows. Mirrors RC-25's AutomationSchedulerService
 * two-phase claim-with-lease design exactly, applied to a richer status
 * lifecycle (pending/retry_scheduled/processing/sent/dead_letter instead of
 * a single nextRunAt scalar):
 *
 * 1. Claim: a conditional UPDATE moves a due row to `processing` and sets
 *    `claimedAt = now`, gated on the lease being free or stale. This picks
 *    a single winner among concurrent dispatcher instances/ticks the same
 *    way Postgres serializes two concurrent UPDATEs on the same row.
 * 2. Re-fetch: confirms this call actually holds the claim it just won
 *    (`status === 'processing' && claimedAt === now`) before doing
 *    anything with the row.
 * 3. Send: via the injected NotificationTransport — SMTP today. Every
 *    terminal state change (`sent`/`retry_scheduled`/`dead_letter`) is
 *    written with `claimedAt: now` still in its own WHERE, so a worker
 *    delayed past its lease — and since reclaimed by another instance —
 *    can never overwrite that instance's outcome for the same delivery.
 *
 * Residual risk, documented rather than hidden: if the SMTP provider
 * accepts the message and then this process crashes before the `sent`
 * update commits, the next reclaim will send the same email again — SMTP
 * itself offers no provider-side idempotency, so this is not a guarantee
 * this dispatcher can make. See docs/RC26_NOTIFICATION_DELIVERY.md.
 */
@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_TRANSPORT)
    private readonly transport: NotificationTransport,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick(): Promise<void> {
    await this.runDueDeliveries(new Date());
  }

  // Split from handleTick() so tests can drive it directly with a
  // controlled `now` instead of waiting on a real clock.
  async runDueDeliveries(now: Date): Promise<void> {
    try {
      this.transport.ensureReady();
    } catch (error) {
      if (error instanceof NotificationsDisabledError) {
        // Not a failure — the feature is simply off. Never claim, never
        // touch the network, never log this as a warning on every tick.
        return;
      }
      if (error instanceof IncompleteSmtpConfigurationError) {
        // A systemic (ops-level) problem, not any one delivery's fault:
        // skip the whole tick rather than burning every due delivery's
        // retry budget against a misconfiguration an operator still needs
        // to fix.
        this.logger.warn(
          `Notification dispatcher : ${redactSensitive(error.message) as string}`,
        );
        return;
      }
      throw error;
    }

    const staleThreshold = new Date(now.getTime() - CLAIM_LEASE_MS);
    const due = await this.prisma.notificationDelivery.findMany({
      where: this.dueSetWhere(now, staleThreshold),
    });

    for (const delivery of due) {
      try {
        await this.processDueDelivery(delivery, now, staleThreshold);
      } catch (error) {
        // One delivery's failure must never stop the rest of this tick.
        this.logger.warn(
          `Notification dispatcher : échec du traitement de la livraison ${delivery.id} (organization=${delivery.organizationId}) : ${
            redactSensitive(
              error instanceof Error ? error.message : 'erreur inconnue',
            ) as string
          }`,
        );
      }
    }
  }

  // Matches: a pending/retry_scheduled row whose nextAttemptAt is due, OR a
  // processing row (meaning some instance claimed it and never finished) —
  // in both cases only while the lease is free or stale. A processing row
  // is matched regardless of nextAttemptAt: that field is meaningless once
  // a claim has actually been taken.
  private dueSetWhere(now: Date, staleThreshold: Date) {
    return {
      AND: [
        {
          OR: [
            {
              status: { in: ['pending', 'retry_scheduled'] },
              nextAttemptAt: { lte: now },
            },
            { status: 'processing' },
          ],
        },
        { OR: [{ claimedAt: null }, { claimedAt: { lt: staleThreshold } }] },
      ],
    };
  }

  private async processDueDelivery(
    delivery: NotificationDelivery,
    now: Date,
    staleThreshold: Date,
  ): Promise<void> {
    // Phase 1 — claim. attemptCount is incremented atomically right here,
    // not at finalize time (RC-26 review fix): this is what makes it count
    // every real pickup — including one interrupted by a crash before any
    // finalize ever runs — rather than only counting definitive failures
    // and leaving a delivery that succeeded on its very first try showing
    // attemptCount: 0.
    const claim = await this.prisma.notificationDelivery.updateMany({
      where: { id: delivery.id, ...this.dueSetWhere(now, staleThreshold) },
      data: {
        status: 'processing',
        claimedAt: now,
        attemptCount: { increment: 1 },
      },
    });
    if (claim.count === 0) {
      return;
    }

    // Phase 2 — re-fetch fresh, verify this call actually holds the claim.
    const fresh = await this.prisma.notificationDelivery.findUnique({
      where: { id: delivery.id },
    });
    if (
      !fresh ||
      fresh.status !== 'processing' ||
      fresh.claimedAt?.getTime() !== now.getTime()
    ) {
      return;
    }

    const recipient = await this.prisma.user.findUnique({
      where: { id: fresh.recipientUserId },
      select: { email: true },
    });
    if (!recipient) {
      await this.markDeadLetter(fresh, now, 'Recipient user no longer exists.');
      return;
    }

    let rendered: { subject: string; text: string };
    try {
      rendered = renderNotificationTemplate(
        fresh.templateKey,
        fresh.templateData,
      );
    } catch (error) {
      // A template that can no longer render (removed, or data that no
      // longer validates) will never succeed on retry.
      await this.markDeadLetter(
        fresh,
        now,
        error instanceof Error ? error.message : 'Invalid template.',
      );
      return;
    }

    try {
      const result = await this.transport.sendEmail({
        to: recipient.email,
        subject: rendered.subject,
        text: rendered.text,
      });
      await this.prisma.notificationDelivery.updateMany({
        where: { id: fresh.id, claimedAt: now },
        data: {
          status: 'sent',
          providerMessageId: result.providerMessageId,
          sentAt: now,
          claimedAt: null,
          lastError: null,
        },
      });
      this.logger.log(
        `Notification ${fresh.id} envoyée à ${maskEmail(recipient.email)} (template=${fresh.templateKey}).`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'erreur inconnue';
      if (error instanceof PermanentNotificationDeliveryError) {
        await this.markDeadLetter(fresh, now, message);
        return;
      }
      // TemporaryNotificationDeliveryError, or any unrecognized error, is
      // treated as retryable — see SmtpNotificationTransport's own
      // classification discipline (an unknown failure is never assumed
      // permanent).
      await this.scheduleRetryOrDeadLetter(fresh, now, message);
    }
  }

  // `delivery.attemptCount` here is always already the post-claim,
  // post-increment value (see processDueDelivery()'s Phase 1) — never
  // incremented again at finalize time.
  private async markDeadLetter(
    delivery: NotificationDelivery,
    now: Date,
    message: string,
  ): Promise<void> {
    await this.prisma.notificationDelivery.updateMany({
      where: { id: delivery.id, claimedAt: now },
      data: {
        status: 'dead_letter',
        claimedAt: null,
        lastError: redactSensitive(message) as string,
      },
    });
  }

  private async scheduleRetryOrDeadLetter(
    delivery: NotificationDelivery,
    now: Date,
    message: string,
  ): Promise<void> {
    const attemptCount = delivery.attemptCount;
    const cleanedMessage = redactSensitive(message) as string;
    if (attemptCount < MAX_ATTEMPTS) {
      await this.prisma.notificationDelivery.updateMany({
        where: { id: delivery.id, claimedAt: now },
        data: {
          status: 'retry_scheduled',
          claimedAt: null,
          nextAttemptAt: new Date(
            now.getTime() + RETRY_BACKOFF_MS[attemptCount - 1],
          ),
          lastError: cleanedMessage,
        },
      });
    } else {
      await this.prisma.notificationDelivery.updateMany({
        where: { id: delivery.id, claimedAt: now },
        data: {
          status: 'dead_letter',
          claimedAt: null,
          lastError: cleanedMessage,
        },
      });
    }
  }
}
