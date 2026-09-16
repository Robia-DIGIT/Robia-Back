import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { auditCompletedEmailProvider } from './notification-policy';

describe('audit email routing policy', () => {
  it.each([undefined, 'n8n', 'notifications', '', 'invalid-secret-value'])(
    'resolves %s safely',
    (value) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const config = new ConfigService({
          AUDIT_COMPLETED_EMAIL_PROVIDER: value,
        });
        expect(auditCompletedEmailProvider(config)).toBe(
          value === 'notifications' ? 'notifications' : 'n8n',
        );
        if (
          value !== undefined &&
          value !== 'n8n' &&
          value !== 'notifications'
        ) {
          expect(warn).toHaveBeenCalledWith(
            'Invalid AUDIT_COMPLETED_EMAIL_PROVIDER; using n8n.',
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        warn.mockRestore();
      }
    },
  );
});
