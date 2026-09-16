import { ConfigService } from '@nestjs/config';
import { SmtpNotificationTransport } from './smtp-notification-transport.service';
import {
  IncompleteSmtpConfigurationError,
  NotificationsDisabledError,
  PermanentNotificationDeliveryError,
  TemporaryNotificationDeliveryError,
} from './notification-transport';

const sendMailMock = jest.fn();
const createTransportMock = jest.fn(() => ({
  sendMail: sendMailMock,
}));

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: () => createTransportMock(),
  },
}));

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (name: string, fallback?: string) => values[name] ?? fallback,
  } as unknown as ConfigService;
}

const ENABLED_COMPLETE_CONFIG = {
  NOTIFICATIONS_ENABLED: 'true',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_SECURE: 'false',
  SMTP_USER: 'no-reply@example.com',
  SMTP_PASSWORD: 'super-secret-password',
  SMTP_FROM_EMAIL: 'no-reply@example.com',
  SMTP_FROM_NAME: 'ROBIA Copilot',
};

describe('SmtpNotificationTransport', () => {
  beforeEach(() => {
    sendMailMock.mockReset();
    createTransportMock.mockClear();
  });

  describe('ensureReady', () => {
    it('throws NotificationsDisabledError when NOTIFICATIONS_ENABLED is not "true", without ever reading SMTP_* vars', () => {
      const config = fakeConfig({ NOTIFICATIONS_ENABLED: 'false' });
      const getSpy = jest.spyOn(config, 'get');
      const transport = new SmtpNotificationTransport(config);

      expect(() => transport.ensureReady()).toThrow(NotificationsDisabledError);
      expect(getSpy).not.toHaveBeenCalledWith('SMTP_HOST');
    });

    it('defaults to disabled when NOTIFICATIONS_ENABLED is absent', () => {
      const transport = new SmtpNotificationTransport(fakeConfig({}));
      expect(() => transport.ensureReady()).toThrow(NotificationsDisabledError);
    });

    it('throws IncompleteSmtpConfigurationError, naming the missing variables, when enabled but misconfigured', () => {
      const transport = new SmtpNotificationTransport(
        fakeConfig({
          NOTIFICATIONS_ENABLED: 'true',
          SMTP_HOST: 'smtp.example.com',
        }),
      );
      try {
        transport.ensureReady();
        throw new Error('expected ensureReady to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(IncompleteSmtpConfigurationError);
        expect((error as Error).message).toContain('SMTP_USER');
        expect((error as Error).message).toContain('SMTP_PASSWORD');
        expect((error as Error).message).not.toContain('super-secret');
      }
    });

    it('never throws when enabled and fully configured', () => {
      const transport = new SmtpNotificationTransport(
        fakeConfig(ENABLED_COMPLETE_CONFIG),
      );
      expect(() => transport.ensureReady()).not.toThrow();
    });
  });

  describe('sendEmail', () => {
    it('never opens a connection while disabled', async () => {
      const transport = new SmtpNotificationTransport(
        fakeConfig({ NOTIFICATIONS_ENABLED: 'false' }),
      );
      await expect(
        transport.sendEmail({
          to: 'jane@example.com',
          subject: 's',
          text: 't',
        }),
      ).rejects.toBeInstanceOf(NotificationsDisabledError);
      expect(createTransportMock).not.toHaveBeenCalled();
    });

    it('rejects a structurally invalid recipient address as permanent, without opening a connection', async () => {
      const transport = new SmtpNotificationTransport(
        fakeConfig(ENABLED_COMPLETE_CONFIG),
      );
      await expect(
        transport.sendEmail({ to: 'not-an-email', subject: 's', text: 't' }),
      ).rejects.toBeInstanceOf(PermanentNotificationDeliveryError);
      expect(createTransportMock).not.toHaveBeenCalled();
    });

    it('sends via nodemailer and returns the provider message id on success', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'msg-123' });
      const transport = new SmtpNotificationTransport(
        fakeConfig(ENABLED_COMPLETE_CONFIG),
      );
      const result = await transport.sendEmail({
        to: 'jane@example.com',
        subject: 'Subject',
        text: 'Body',
      });
      expect(result).toEqual({ providerMessageId: 'msg-123' });
      expect(sendMailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'jane@example.com',
          subject: 'Subject',
          text: 'Body',
        }),
      );
    });

    it('classifies an SMTP 5xx response as permanent', async () => {
      sendMailMock.mockRejectedValue(
        Object.assign(new Error('mailbox unavailable'), { responseCode: 550 }),
      );
      const transport = new SmtpNotificationTransport(
        fakeConfig(ENABLED_COMPLETE_CONFIG),
      );
      await expect(
        transport.sendEmail({
          to: 'jane@example.com',
          subject: 's',
          text: 't',
        }),
      ).rejects.toBeInstanceOf(PermanentNotificationDeliveryError);
    });

    it('classifies an SMTP 4xx response as temporary', async () => {
      sendMailMock.mockRejectedValue(
        Object.assign(new Error('mailbox busy'), { responseCode: 450 }),
      );
      const transport = new SmtpNotificationTransport(
        fakeConfig(ENABLED_COMPLETE_CONFIG),
      );
      await expect(
        transport.sendEmail({
          to: 'jane@example.com',
          subject: 's',
          text: 't',
        }),
      ).rejects.toBeInstanceOf(TemporaryNotificationDeliveryError);
    });

    it('classifies a connection-level failure (no responseCode) as temporary', async () => {
      sendMailMock.mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      );
      const transport = new SmtpNotificationTransport(
        fakeConfig(ENABLED_COMPLETE_CONFIG),
      );
      await expect(
        transport.sendEmail({
          to: 'jane@example.com',
          subject: 's',
          text: 't',
        }),
      ).rejects.toBeInstanceOf(TemporaryNotificationDeliveryError);
    });
  });
});
