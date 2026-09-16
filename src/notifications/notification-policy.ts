import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const MAX_NOTIFICATION_ATTEMPTS = 5;
const logger = new Logger('NotificationPolicy');

// Shared routing decision; never log the supplied value (it may contain secrets).
export function auditCompletedEmailProvider(
  config: ConfigService,
): 'n8n' | 'notifications' {
  const provider = config.get<string>('AUDIT_COMPLETED_EMAIL_PROVIDER');
  if (provider === 'notifications' || provider === 'n8n') return provider;
  if (provider !== undefined) {
    logger.warn('Invalid AUDIT_COMPLETED_EMAIL_PROVIDER; using n8n.');
  }
  return 'n8n';
}
