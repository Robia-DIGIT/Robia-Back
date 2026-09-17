// RC-26 — the transport abstraction that keeps NotificationDispatcherService
// independent of any specific email provider. SMTP (via Nodemailer) is the
// only implementation today (SmtpNotificationTransport); a future provider
// swap only ever needs a new class satisfying this interface, never a
// change to the dispatcher's claim/retry/backoff logic.

export interface SendEmailParams {
  to: string;
  subject: string;
  text: string;
}

export interface SendEmailResult {
  providerMessageId: string;
}

export interface NotificationTransport {
  // Cheap, synchronous, no network: throws immediately if the feature is
  // disabled or misconfigured, so the dispatcher can decide to skip an
  // entire tick without ever touching the network or burning a delivery's
  // retry budget on a systemic (ops-level) problem.
  ensureReady(): void;
  sendEmail(params: SendEmailParams): Promise<SendEmailResult>;
}

export const NOTIFICATION_TRANSPORT = Symbol('NOTIFICATION_TRANSPORT');

// Thrown by ensureReady() when NOTIFICATIONS_ENABLED is not "true". Never
// thrown mid-send — the dispatcher always checks readiness first and skips
// the tick entirely rather than ever calling sendEmail() while disabled, so
// this is also the guarantee that no network connection is ever attempted
// while the feature is off.
export class NotificationsDisabledError extends Error {
  constructor() {
    super('Notification delivery is disabled (NOTIFICATIONS_ENABLED != true).');
  }
}

// Thrown by ensureReady() when the feature is enabled but one or more
// required SMTP_* variables are missing. The message names which variables
// are missing — never their values, and never other configured values —
// so this can be logged as-is without redaction concerns.
export class IncompleteSmtpConfigurationError extends Error {
  constructor(missing: string[]) {
    super(
      `Notification delivery is enabled but SMTP configuration is incomplete: missing ${missing.join(', ')}.`,
    );
  }
}

// A failure that is worth retrying: a network/connection error, a timeout,
// or an SMTP 4xx (temporary) response.
export class TemporaryNotificationDeliveryError extends Error {}

// A failure that will never succeed on retry: an SMTP 5xx (permanent)
// response, or a recipient address rejected as invalid.
export class PermanentNotificationDeliveryError extends Error {}
