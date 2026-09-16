import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, NotificationDelivery } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { renderNotificationTemplate } from './notification-templates';

// Never surfaced as an HTTP response — createEmailDelivery() only ever runs
// from inside AutomationsService.executeSteps(), which already redacts and
// stores any thrown error as the step's failure reason. A plain Error is
// enough here; it does not need its own HTTP status mapping.
export class NotificationAutomationContextError extends Error {}

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
  templateData: unknown;
}

export interface CreateEmailDeliveryResult {
  delivery: NotificationDelivery;
  recipientEmail: string;
}

// A delivery can be manually retried from exactly this status — the only
// terminal failure state this module has (there is no separate "failed":
// dead_letter already means "exhausted every automatic retry").
const RETRYABLE_STATUSES = ['dead_letter'];

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

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
    // Fail fast: never persist a delivery whose template/variables could
    // never actually render into a valid email later.
    renderNotificationTemplate(params.templateKey, params.templateData);

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
          templateData: params.templateData as Prisma.InputJsonValue,
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
  async retry(
    organizationId: string,
    id: string,
  ): Promise<NotificationDelivery> {
    const delivery = await this.findOne(organizationId, id);
    if (!RETRYABLE_STATUSES.includes(delivery.status)) {
      throw new NotificationRetryNotAllowedError(
        `Only a delivery in one of [${RETRYABLE_STATUSES.join(', ')}] can be manually retried (current status: "${delivery.status}").`,
      );
    }
    return this.prisma.notificationDelivery.update({
      where: { id },
      data: {
        status: 'pending',
        nextAttemptAt: new Date(),
        claimedAt: null,
      },
    });
  }
}
