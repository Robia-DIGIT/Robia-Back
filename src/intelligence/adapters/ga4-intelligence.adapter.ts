import { Injectable, Logger } from '@nestjs/common';
import { GoogleSearchConsoleService } from '../../integrations/google-search-console.service';
import {
  IntelligenceFinding,
  IntelligenceProviderAdapter,
  IntelligenceSignal,
} from '../intelligence.types';

/**
 * RC-21 — GA4 adapter, built entirely on RC-13's existing
 * `GoogleSearchConsoleService` (the same Google OAuth connection carries
 * both Search Console and Analytics scopes).
 *
 * Unlike Search Console, there is no persisted per-day GA4 snapshot table
 * (RC-13 scope) — `getAnalyticsPerformance()` is a live, on-demand call,
 * already used today by GA4's own dashboard endpoint. This adapter reuses
 * that exact method rather than inventing a second GA4 code path; it does
 * NOT call it unconditionally, though: `getStatus()` (a plain, network-free
 * Prisma read) is checked first, so an org that has never connected GA4 —
 * or connected but never selected a property — costs one DB read here,
 * never a live Google API call. Only a genuinely connected-and-configured
 * organization triggers the same live call its own dashboard would.
 */
@Injectable()
export class Ga4IntelligenceAdapter implements IntelligenceProviderAdapter {
  private readonly logger = new Logger(Ga4IntelligenceAdapter.name);

  readonly provider = 'ga4' as const;
  readonly readOnly = true;
  readonly scoreInfluence = false;

  constructor(
    private readonly googleSearchConsole: GoogleSearchConsoleService,
  ) {}

  async collectSignal(organizationId: string): Promise<IntelligenceSignal> {
    const status = await this.googleSearchConsole.getStatus(organizationId);

    if (!status.connected) {
      return this.unavailable(organizationId, 'not_connected', null);
    }
    if (!status.analyticsAuthorized) {
      return this.unavailable(
        organizationId,
        'not_configured',
        status.lastAnalyticsSyncedAt,
        'analytics_scope_not_granted',
      );
    }
    if (!status.selectedAnalyticsPropertyId) {
      return this.unavailable(
        organizationId,
        'not_configured',
        status.lastAnalyticsSyncedAt,
        'no_property_selected',
      );
    }

    try {
      const performance =
        await this.googleSearchConsole.getAnalyticsPerformance(organizationId);
      return {
        provider: this.provider,
        status: 'ok',
        organizationId,
        observedAt: performance.lastSyncedAt,
        readOnly: this.readOnly,
        scoreInfluence: this.scoreInfluence,
        data: performance,
        unavailableReason: null,
      };
    } catch (error) {
      this.logger.warn(
        `GA4 : lecture des performances indisponible pour organization=${organizationId}: ${error instanceof Error ? error.message : 'erreur inconnue'}`,
      );
      return this.unavailable(
        organizationId,
        'unavailable',
        status.lastAnalyticsSyncedAt,
        'temporarily_unavailable',
      );
    }
  }

  private unavailable(
    organizationId: string,
    status: IntelligenceSignal['status'],
    observedAt: Date | null,
    unavailableReason: string = status,
  ): IntelligenceSignal {
    return {
      provider: this.provider,
      status,
      organizationId,
      observedAt,
      readOnly: this.readOnly,
      scoreInfluence: this.scoreInfluence,
      data: null,
      unavailableReason,
    };
  }

  // Trailing params (organizationId, context) are unused and deliberately
  // omitted — TS structurally satisfies IntelligenceProviderAdapter with a
  // shorter implementation.
  // eslint-disable-next-line @typescript-eslint/require-await -- interface requires a Promise; GA4 has no finding rules in RC-21.
  async collectFindings(): Promise<IntelligenceFinding[]> {
    return [];
  }
}
