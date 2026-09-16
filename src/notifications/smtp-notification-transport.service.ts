import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import {
  IncompleteSmtpConfigurationError,
  NotificationTransport,
  NotificationsDisabledError,
  PermanentNotificationDeliveryError,
  SendEmailParams,
  SendEmailResult,
  TemporaryNotificationDeliveryError,
} from './notification-transport';

// A nodemailer send rejection carries the SMTP response code (when the
// server actively rejected the message after connecting) as a numeric
// `responseCode`, and a connection-level failure code (ECONNREFUSED,
// ETIMEDOUT, ...) as a string `code` instead — never both.
interface NodemailerSendError {
  responseCode?: number;
  code?: string;
  message?: string;
}

const REQUIRED_SMTP_VARS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_FROM_EMAIL',
] as const;

// Deliberately simple — this only needs to catch a structurally malformed
// address before it ever reaches the network, not fully validate RFC 5322.
// A real, well-formed-but-nonexistent address is still correctly classified
// as permanent, just via the SMTP 5xx path in classifyError() instead.
const BASIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * RC-26 — the only implementation of NotificationTransport today. Real SMTP
 * delivery via Nodemailer, gated end-to-end by NOTIFICATIONS_ENABLED: while
 * that flag is not exactly "true", ensureReady() always throws before any
 * of the SMTP_* variables are even read, let alone before a socket is ever
 * opened — there is no "simulated send" path presented as a real one.
 */
@Injectable()
export class SmtpNotificationTransport implements NotificationTransport {
  constructor(private readonly config: ConfigService) {}

  ensureReady(): void {
    if (!this.isEnabled()) {
      throw new NotificationsDisabledError();
    }
    const missing = REQUIRED_SMTP_VARS.filter(
      (name) => !this.config.get<string>(name)?.trim(),
    );
    if (missing.length > 0) {
      throw new IncompleteSmtpConfigurationError(missing);
    }
  }

  isEnabled(): boolean {
    return this.config.get<string>('NOTIFICATIONS_ENABLED', 'false') === 'true';
  }

  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    // Re-checked here (not just by the dispatcher) so this class can never
    // be used to send while disabled/misconfigured regardless of caller.
    this.ensureReady();

    const host = this.config.get<string>('SMTP_HOST')!.trim();
    const port = Number(this.config.get<string>('SMTP_PORT'));
    const secure = this.config.get<string>('SMTP_SECURE', 'true') === 'true';
    const user = this.config.get<string>('SMTP_USER')!.trim();
    const password = this.config.get<string>('SMTP_PASSWORD')!.trim();
    const fromEmail = this.config.get<string>('SMTP_FROM_EMAIL')!.trim();
    const fromName = this.config.get<string>('SMTP_FROM_NAME', 'ROBIA Copilot');

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new IncompleteSmtpConfigurationError(['SMTP_PORT']);
    }

    // A structurally invalid recipient address is a permanent failure by
    // construction — retrying can never fix it — so it is rejected here,
    // before any connection is opened, rather than left to however
    // nodemailer/the SMTP server happens to report it.
    if (!BASIC_EMAIL_PATTERN.test(params.to)) {
      throw new PermanentNotificationDeliveryError(
        'Recipient address is not a well-formed email address.',
      );
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass: password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });

    try {
      const info = await transporter.sendMail({
        from: `${fromName} <${fromEmail}>`,
        to: params.to,
        subject: params.subject,
        text: params.text,
      });
      return { providerMessageId: info.messageId };
    } catch (error) {
      throw this.classifyError(error);
    }
  }

  private classifyError(error: unknown): Error {
    const { responseCode, message } = error as NodemailerSendError;
    const cleanMessage =
      typeof message === 'string' ? message : 'SMTP send failed';
    if (typeof responseCode === 'number' && responseCode >= 500) {
      return new PermanentNotificationDeliveryError(cleanMessage);
    }
    // Everything else — an SMTP 4xx response, a connection/timeout/DNS
    // failure with no responseCode at all, or an unrecognized error shape —
    // is treated as temporary: retrying is always safe, whereas treating an
    // unrecognized failure as permanent could dead-letter a delivery that
    // would have succeeded on the next attempt.
    return new TemporaryNotificationDeliveryError(cleanMessage);
  }
}
