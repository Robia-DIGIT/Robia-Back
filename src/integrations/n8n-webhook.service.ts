import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface UserRegisteredEvent {
  email: string;
  name: string | null;
  organizationName: string | null;
}

interface AuditCompletedEvent {
  auditId: string;
  email: string;
  userName: string | null;
  websiteUrl: string;
  score: number | null;
  opportunities: string[];
  completedAt: Date;
}

interface ProspectCreatedEvent {
  name: string;
  email: string;
  phone?: string;
  company?: string;
  message: string;
}

@Injectable()
export class N8nWebhookService {
  private readonly logger = new Logger(N8nWebhookService.name);

  constructor(private readonly config: ConfigService) {}

  notifyUserRegistered(event: UserRegisteredEvent) {
    return this.deliver('robia-user-registered', {
      email: event.email,
      name: event.name,
      organizationName: event.organizationName,
      dashboardUrl: this.dashboardUrl('/login'),
    });
  }

  notifyAuditCompleted(event: AuditCompletedEvent) {
    return this.deliver('robia-audit-completed', {
      eventId: `audit-completed:${event.auditId}`,
      email: event.email,
      userName: event.userName,
      websiteUrl: event.websiteUrl,
      score: event.score,
      opportunities: event.opportunities.slice(0, 5),
      dashboardUrl: this.dashboardUrl(),
      completedAt: event.completedAt.toISOString(),
    });
  }

  notifyProspectCreated(event: ProspectCreatedEvent) {
    return this.deliver('robia-prospect-created', {
      ...event,
      source: 'Site vitrine ROBIA',
      createdAt: new Date().toISOString(),
    });
  }

  private async deliver(path: string, payload: Record<string, unknown>) {
    const endpoint = this.endpoint(path);
    const secret = this.config.get<string>('N8N_WEBHOOK_SECRET')?.trim();

    if (!endpoint || !secret || !/^[0-9a-f]{64}$/i.test(secret)) {
      this.logger.warn(
        `Webhook n8n ${path} non envoyé : configuration absente`,
      );
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs());

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Robia-Webhook-Secret': secret,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          `Webhook n8n ${path} refusé avec le statut ${response.status}`,
        );
        return false;
      }

      return true;
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? 'délai dépassé'
          : 'connexion impossible';
      this.logger.warn(`Webhook n8n ${path} non envoyé : ${reason}`);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private endpoint(path: string) {
    const configured = this.config.get<string>('N8N_WEBHOOK_BASE_URL')?.trim();

    if (!configured) {
      return null;
    }

    try {
      const base = new URL(
        configured.endsWith('/') ? configured : `${configured}/`,
      );
      if (
        !['http:', 'https:'].includes(base.protocol) ||
        (process.env.NODE_ENV === 'production' && base.protocol !== 'https:')
      ) {
        this.logger.warn('URL n8n refusée : protocole invalide');
        return null;
      }
      return new URL(path, base);
    } catch {
      this.logger.warn('URL n8n refusée : format invalide');
      return null;
    }
  }

  private dashboardUrl(path = '') {
    const base = this.config.get<string>('DASHBOARD_URL')?.trim();
    const dashboard = base || 'https://app.robiacopilot.site';
    return `${dashboard.replace(/\/$/, '')}${path}`;
  }

  private timeoutMs() {
    const configured = Number(
      this.config.get<string>('N8N_WEBHOOK_TIMEOUT_MS', '5000'),
    );
    return Number.isFinite(configured) &&
      configured >= 1000 &&
      configured <= 10000
      ? configured
      : 5000;
  }
}
