import { Injectable, Logger } from '@nestjs/common';
import { SeoIntelligenceAdapter } from './adapters/seo-intelligence.adapter';
import { PageSpeedIntelligenceAdapter } from './adapters/pagespeed-intelligence.adapter';
import { SearchConsoleIntelligenceAdapter } from './adapters/search-console-intelligence.adapter';
import { Ga4IntelligenceAdapter } from './adapters/ga4-intelligence.adapter';
import { MetaIntelligenceAdapter } from './adapters/meta-intelligence.adapter';
import { GbpIntelligenceAdapter } from './adapters/gbp-intelligence.adapter';
import {
  AuditIntelligenceContext,
  IntelligenceFinding,
  IntelligenceProviderAdapter,
  IntelligenceSignal,
} from './intelligence.types';

/**
 * RC-21 — the single place that knows about every registered provider
 * adapter. Every consumer (the `/intelligence/status` controller,
 * `OpportunitiesService`) goes through this service rather than injecting
 * individual adapters, so adding a future provider never requires
 * touching a consumer.
 *
 * Both public methods isolate each adapter behind `Promise.allSettled`:
 * one provider throwing (a bug, an unexpected exception an adapter failed
 * to catch) degrades to a `status: 'unavailable'` signal / an empty
 * findings array for that provider alone — it never prevents the other
 * providers from being read. This is the direct implementation of RC-21's
 * "provider en panne : les autres fonctionnent" requirement, enforced
 * centrally rather than trusted to every adapter individually.
 */
@Injectable()
export class IntelligenceRegistryService {
  private readonly logger = new Logger(IntelligenceRegistryService.name);
  private readonly adapters: IntelligenceProviderAdapter[];

  constructor(
    seo: SeoIntelligenceAdapter,
    pagespeed: PageSpeedIntelligenceAdapter,
    searchConsole: SearchConsoleIntelligenceAdapter,
    ga4: Ga4IntelligenceAdapter,
    meta: MetaIntelligenceAdapter,
    gbp: GbpIntelligenceAdapter,
  ) {
    this.adapters = [seo, pagespeed, searchConsole, ga4, meta, gbp];
  }

  async getStatus(organizationId: string): Promise<IntelligenceSignal[]> {
    const results = await Promise.allSettled(
      this.adapters.map((adapter) => adapter.collectSignal(organizationId)),
    );
    return results.map((result, index) => {
      const adapter = this.adapters[index];
      if (result.status === 'fulfilled') {
        return result.value;
      }
      this.logger.warn(
        `Intelligence : le provider "${adapter.provider}" a échoué pour organization=${organizationId}: ${
          result.reason instanceof Error
            ? result.reason.message
            : 'erreur inconnue'
        }`,
      );
      return {
        provider: adapter.provider,
        status: 'unavailable',
        organizationId,
        observedAt: null,
        readOnly: adapter.readOnly,
        scoreInfluence: adapter.scoreInfluence,
        data: null,
        unavailableReason: 'temporarily_unavailable',
      } satisfies IntelligenceSignal;
    });
  }

  async collectFindings(
    organizationId: string,
    context: AuditIntelligenceContext,
  ): Promise<IntelligenceFinding[]> {
    const results = await Promise.allSettled(
      this.adapters.map((adapter) =>
        adapter.collectFindings(organizationId, context),
      ),
    );
    const findings: IntelligenceFinding[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        findings.push(...result.value);
        return;
      }
      const adapter = this.adapters[index];
      this.logger.warn(
        `Intelligence : la collecte de findings du provider "${adapter.provider}" a échoué pour organization=${organizationId}, audit=${context.auditId}: ${
          result.reason instanceof Error
            ? result.reason.message
            : 'erreur inconnue'
        }`,
      );
    });
    return findings;
  }
}
