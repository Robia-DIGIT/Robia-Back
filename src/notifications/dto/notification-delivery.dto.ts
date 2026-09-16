import { maskEmail } from '../mask-email';
import { NotificationDeliveryWithRecipient } from '../notifications.service';

// The shape ever returned to a client — deliberately narrower than the
// Prisma row: templateData can contain a website URL or an organization
// name (not secret, but not something every list view needs either) and is
// omitted from the list view; recipientUserId is replaced by a masked
// email rather than exposing the raw user id or address.
export interface NotificationDeliverySummary {
  id: string;
  channel: string;
  templateKey: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: string;
  recipientMasked: string;
  providerMessageId: string | null;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toNotificationDeliverySummary(
  delivery: NotificationDeliveryWithRecipient,
): NotificationDeliverySummary {
  return {
    id: delivery.id,
    channel: delivery.channel,
    templateKey: delivery.templateKey,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    nextAttemptAt: delivery.nextAttemptAt.toISOString(),
    recipientMasked: maskEmail(delivery.recipient.email),
    providerMessageId: delivery.providerMessageId,
    lastError: delivery.lastError,
    sentAt: delivery.sentAt ? delivery.sentAt.toISOString() : null,
    createdAt: delivery.createdAt.toISOString(),
    updatedAt: delivery.updatedAt.toISOString(),
  };
}
