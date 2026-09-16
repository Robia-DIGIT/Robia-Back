import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, NotificationDelivery } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  auditCompletedEmailProvider,
  MAX_NOTIFICATION_ATTEMPTS,
} from './notification-policy';
import { PrismaService } from '../prisma/prisma.service';
import { renderNotificationTemplate } from './notification-templates';

// Never surfaced as an HTTP response — createEmailDelivery() only ever runs
// from inside AutomationsService.executeSteps(), which already redacts and
// stores any thrown error as the step's failure reason. A plain Error is
// enough here; it does not need its own HTTP status mapping.
export class NotificationAutomationContextError extends Error {}

// Same reasoning: thrown by resolveAuditCompletedData(), consumed only by
// executeSteps()'s own catch — never an HTTP response.
export class NotificationAuditResolutionError extends Error {}

// Thrown by NotificationsService.retry(), called directly from
// NotificationsController — extends ConflictException (409) the same way
// AutomationRunConflictError does, so Nest's default handling maps it
// correctly without a dedicated exception filter.
export class NotificationRetryNotAllowedError extends ConflictException {}

export type NotificationDeliveryWithRecipient =
  Prisma.NotificationDeliveryGetPayload<{
    include: { recipient: { select: { email: true } } };
  }>;

export interface CreateEmailDeliveryParams {
  organizationId: string;
  automationId: string;
  automationRunId: string;
  automationStepRunId: string;
  templateKey: string;
  // Optional because it is entirely ignored for 'audit_completed' (see
  // resolveTemplateData()) — required in practice for every other
  // template, enforced by renderNotificationTemplate()'s own validation.
  templateData?: unknown;
  // Required (and the *only* source of templateData) when templateKey is
  // 'audit_completed' — see resolveTemplateData(). Ignored by every other
  // template.
  auditId?: string;
}

export interface CreateEmailDeliveryResult {
  delivery: NotificationDelivery | null;
  recipientEmail: string;
  reason?: 'handled_by_n8n';
}

// A delivery can be manually retried from exactly this status — the only
// terminal failure state this module has (there is no separate "failed":
// dead_letter already means "exhausted every automatic retry").
const RETRYABLE_STATUSES = ['dead_letter'];

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // Called exclusively by OpsActionsRegistryService's
  // robia.notification.send_email action, from inside an automation run's
  // executeSteps() — never directly by a controller. Idempotent by
  // construction: a repeat call for the same automationStepRunId (the same
  // run replaying, or — in principle — the same step re-invoked by a
  // future retry mechanism) always returns the exact same row, never a
  // second delivery.
  async createEmailDelivery(
    params: CreateEmailDeliveryParams,
  ): Promise<CreateEmailDeliveryResult> {
    if (
      params.templateKey === 'audit_completed' &&
      auditCompletedEmailProvider(this.config) === 'n8n'
    ) {
      return { delivery: null, recipientEmail: '', reason: 'handled_by_n8n' };
    }
    // RC-26 review fix: the real audit.completed event (see
    // audit-completed.event.ts) only ever carries auditId/websiteId/
    // globalScore — never a websiteUrl string — so audit_completed's
    // templateData can no longer be trusted verbatim from the automation
    // step's own (static, potentially stale) input. It is always resolved
    // fresh from the Audit record instead, org-scoped, with an absent
    // score handled explicitly.
    const templateData = await this.resolveTemplateData(params);
    // Fail fast: never persist a delivery whose template/variables could
    // never actually render into a valid email later.
    renderNotificationTemplate(params.templateKey, templateData);

    const automation = await this.prisma.automation.findUnique({
      where: { id: params.automationId },
      include: { createdBy: true },
    });
    if (!automation || automation.organizationId !== params.organizationId) {
      throw new NotificationAutomationContextError(
        'Automation does not belong to the expected organization.',
      );
    }
    const organization = await this.prisma.organization.findUnique({
      where: { id: params.organizationId },
      select: { ownerId: true },
    });
    // The recipient is always Automation.createdById, resolved server-side
    // — but that user must also actually be this organization's own owner.
    // Today's org model has exactly one owner per organization (see
    // OrgScopeGuard), so this is the same check that guard performs,
    // applied here instead of trusting createdById blindly.
    if (!organization || organization.ownerId !== automation.createdById) {
      throw new NotificationAutomationContextError(
        "Automation's creator does not belong to the expected organization.",
      );
    }

    const idempotencyKey = `automation-step:${params.automationStepRunId}`;
    const recipientEmail = automation.createdBy.email;

    try {
      const delivery = await this.prisma.notificationDelivery.create({
        data: {
          organizationId: params.organizationId,
          recipientUserId: automation.createdById,
          channel: 'email',
          templateKey: params.templateKey,
          templateData: templateData as Prisma.InputJsonValue,
          idempotencyKey,
          automationRunId: params.automationRunId,
          automationStepRunId: params.automationStepRunId,
        },
      });
      return { delivery, recipientEmail };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.notificationDelivery.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: params.organizationId,
              idempotencyKey,
            },
          },
        });
        if (existing) {
          return { delivery: existing, recipientEmail };
        }
      }
      throw error;
    }
  }

  // For every template except audit_completed, templateData is exactly
  // whatever the caller (the ops action) supplied — generic, validated
  // generically by renderNotificationTemplate(). audit_completed is the
  // one exception: its data is always resolved fresh from the real Audit
  // record, scoped to this organization, never from the caller's own
  // (static, potentially stale, and — per the real audit.completed event
  // shape — structurally unable to carry a websiteUrl at all) templateData.
  private async resolveTemplateData(
    params: CreateEmailDeliveryParams,
  ): Promise<unknown> {
    if (params.templateKey !== 'audit_completed') {
      return params.templateData;
    }
    if (!params.auditId) {
      throw new NotificationAuditResolutionError(
        'audit_completed requires auditId.',
      );
    }
    const audit = await this.prisma.audit.findFirst({
      where: { id: params.auditId, organizationId: params.organizationId },
      include: { website: { select: { url: true } } },
    });
    if (!audit) {
      throw new NotificationAuditResolutionError(
        'Audit does not belong to the expected organization.',
      );
    }
    return {
      websiteUrl: audit.website.url,
      // An absent score (Audit.globalScore === null — see
      // audit-completed.event.ts's own doc comment on when this happens)
      // is handled explicitly here, once, rather than leaving the
      // template to render "null/100" or silently reject the whole
      // notification.
      scoreLine:
        audit.globalScore != null
          ? `${audit.globalScore}/100`
          : 'non disponible',
    };
  }

  async findAllForOrganization(
    organizationId: string,
  ): Promise<NotificationDeliveryWithRecipient[]> {
    return this.prisma.notificationDelivery.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { recipient: { select: { email: true } } },
    });
  }

  async findOne(
    organizationId: string,
    id: string,
  ): Promise<NotificationDeliveryWithRecipient> {
    const delivery = await this.prisma.notificationDelivery.findFirst({
      where: { id, organizationId },
      include: { recipient: { select: { email: true } } },
    });
    if (!delivery) {
      throw new NotFoundException('Notification introuvable.');
    }
    return delivery;
  }

  // Puts a dead_letter delivery back in the queue without creating a new
  // row and without touching its idempotencyKey — the dispatcher's own
  // claim/send logic (including its retry/backoff bookkeeping) runs
  // exactly as it would for any other pending delivery.
  //
  // RC-26 review fix: the transition is a conditional `updateMany` gated
  // on `status` still being retryable *at write time* — never a plain
  // read-then-write `update()`. The earlier design read the status, then
  // wrote unconditionally: two concurrent retry requests (or a retry
  // racing a dispatcher worker that had already reclaimed the delivery
  // after a stale-lease timeout) could both pass the read-time check and
  // then both write, the second one silently clobbering whatever the
  // first request — or the worker — had already done, including resetting
  // `claimedAt` out from under an in-flight send.
  async retry(
    organizationId: string,
    id: string,
  ): Promise<NotificationDelivery> {
    // 404 first, for a friendly error when the delivery simply doesn't
    // exist or belongs to a different organization — never itself the
    // source of truth for the state transition below.
    const existing = await this.findOne(organizationId, id);
    // Manual retry uses only the remaining lifetime budget; no hidden reset.
    if (existing.attemptCount >= MAX_NOTIFICATION_ATTEMPTS) {
      throw new NotificationRetryNotAllowedError(
        'Notification attempt limit reached.',
      );
    }
    if (!RETRYABLE_STATUSES.includes(existing.status)) {
      throw new NotificationRetryNotAllowedError(
        `Only a delivery in one of [${RETRYABLE_STATUSES.join(', ')}] can be manually retried (current status: "${existing.status}").`,
      );
    }

    const result = await this.prisma.notificationDelivery.updateMany({
      where: {
        id,
        organizationId,
        status: { in: RETRYABLE_STATUSES },
        attemptCount: { lt: MAX_NOTIFICATION_ATTEMPTS },
      },
      data: {
        status: 'pending',
        nextAttemptAt: new Date(),
        claimedAt: null,
      },
    });
    if (result.count === 0) {
      // Raced: something else (another retry request, or the dispatcher)
      // changed this delivery's status between the read above and this
      // conditional write — never silently proceed as if it had worked.
      throw new NotificationRetryNotAllowedError(
        'This delivery is no longer eligible for a manual retry (its status changed concurrently).',
      );
    }
    const updated = await this.prisma.notificationDelivery.findUnique({
      where: { id },
    });
    return updated!;
  }
}
