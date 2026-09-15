import { IntelligenceRegistryService } from './intelligence-registry.service';
import { SeoIntelligenceAdapter } from './adapters/seo-intelligence.adapter';
import { PageSpeedIntelligenceAdapter } from './adapters/pagespeed-intelligence.adapter';
import { SearchConsoleIntelligenceAdapter } from './adapters/search-console-intelligence.adapter';
import { Ga4IntelligenceAdapter } from './adapters/ga4-intelligence.adapter';
import { MetaIntelligenceAdapter } from './adapters/meta-intelligence.adapter';
import { GbpIntelligenceAdapter } from './adapters/gbp-intelligence.adapter';
import { IntelligenceProvider } from './intelligence.types';

interface MockAdapter {
  provider: IntelligenceProvider;
  readOnly: boolean;
  scoreInfluence: boolean;
  collectSignal: jest.Mock;
  collectFindings: jest.Mock;
}

function mockAdapter(provider: IntelligenceProvider): MockAdapter {
  return {
    provider,
    readOnly: true,
    scoreInfluence: false,
    collectSignal: jest.fn().mockResolvedValue({
      provider,
      status: 'ok',
      organizationId: 'org-1',
      observedAt: null,
      readOnly: true,
      scoreInfluence: false,
      data: { ok: true },
      unavailableReason: null,
    }),
    collectFindings: jest.fn().mockResolvedValue([]),
  };
}

describe('IntelligenceRegistryService', () => {
  const organizationId = 'org-1';

  function buildRegistry(
    overrides: Partial<Record<IntelligenceProvider, MockAdapter>> = {},
  ) {
    const seo = overrides.seo ?? mockAdapter('seo');
    const pagespeed = overrides.pagespeed ?? mockAdapter('pagespeed');
    const searchConsole =
      overrides.search_console ?? mockAdapter('search_console');
    const ga4 = overrides.ga4 ?? mockAdapter('ga4');
    const meta = overrides.meta ?? mockAdapter('meta');
    const gbp = overrides.gbp ?? mockAdapter('gbp');
    const registry = new IntelligenceRegistryService(
      seo as unknown as SeoIntelligenceAdapter,
      pagespeed as unknown as PageSpeedIntelligenceAdapter,
      searchConsole as unknown as SearchConsoleIntelligenceAdapter,
      ga4 as unknown as Ga4IntelligenceAdapter,
      meta as unknown as MetaIntelligenceAdapter,
      gbp as unknown as GbpIntelligenceAdapter,
    );
    return {
      registry,
      adapters: { seo, pagespeed, searchConsole, ga4, meta, gbp },
    };
  }

  describe('getStatus', () => {
    it('returns one signal per registered provider', async () => {
      const { registry } = buildRegistry();
      const signals = await registry.getStatus(organizationId);
      expect(signals.map((s) => s.provider).sort()).toEqual(
        ['seo', 'pagespeed', 'search_console', 'ga4', 'meta', 'gbp'].sort(),
      );
    });

    it('isolates a provider that throws — every other provider still returns its real signal (provider en panne)', async () => {
      const meta = mockAdapter('meta');
      meta.collectSignal.mockRejectedValue(new Error('Meta Graph down'));
      const { registry, adapters } = buildRegistry({ meta });

      const signals = await registry.getStatus(organizationId);

      const metaSignal = signals.find((s) => s.provider === 'meta');
      expect(metaSignal?.status).toBe('unavailable');
      expect(metaSignal?.data).toBeNull();
      // Every other provider is completely unaffected by Meta's failure —
      // this is the actual mechanism behind "provider en panne : les
      // autres fonctionnent", not a documentation comment.
      const seoSignal = signals.find((s) => s.provider === 'seo');
      expect(seoSignal?.status).toBe('ok');
      expect(adapters.seo.collectSignal).toHaveBeenCalledTimes(1);
      expect(adapters.pagespeed.collectSignal).toHaveBeenCalledTimes(1);
      expect(adapters.gbp.collectSignal).toHaveBeenCalledTimes(1);
    });

    it('never lets one provider signal carry another provider organizationId', async () => {
      const { registry } = buildRegistry();
      const signals = await registry.getStatus(organizationId);
      for (const signal of signals) {
        expect(signal.organizationId).toBe(organizationId);
      }
    });
  });

  describe('collectFindings', () => {
    it('aggregates findings from every provider that returns some', async () => {
      const meta = mockAdapter('meta');
      meta.collectFindings.mockResolvedValue([
        {
          provider: 'meta',
          ruleCode: 'META_INSTAGRAM_NOT_LINKED',
          title: 't',
          description: 'd',
          category: 'social',
          evidence: [],
          recommendation: 'r',
          impactScore: 3,
          effortScore: 2,
          confidenceScore: 0.9,
          scoreInfluence: false,
        },
      ]);
      const { registry } = buildRegistry({ meta });

      const findings = await registry.collectFindings(organizationId, {
        auditId: 'audit-1',
        auditResult: null,
      });

      expect(findings).toHaveLength(1);
      expect(findings[0].provider).toBe('meta');
    });

    it('isolates a provider whose finding collection rejects — other providers findings still come through (provider en panne)', async () => {
      const meta = mockAdapter('meta');
      meta.collectFindings.mockRejectedValue(new Error('Meta Graph down'));
      const seo = mockAdapter('seo');
      seo.collectFindings.mockResolvedValue([
        {
          provider: 'seo',
          ruleCode: 'SOME_SEO_RULE',
          title: 't',
          description: 'd',
          category: 'content',
          evidence: [],
          recommendation: 'r',
          impactScore: 5,
          effortScore: 5,
          confidenceScore: 1,
          scoreInfluence: false,
        },
      ]);
      const { registry } = buildRegistry({ meta, seo });

      const findings = await registry.collectFindings(organizationId, {
        auditId: 'audit-1',
        auditResult: null,
      });

      // The rejected provider contributes nothing, but does not prevent
      // the well-behaved provider's findings from coming through, and the
      // call itself never rejects.
      expect(findings).toHaveLength(1);
      expect(findings[0].provider).toBe('seo');
    });
  });
});
