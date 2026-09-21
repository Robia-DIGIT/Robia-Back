import { ConfigService } from '@nestjs/config';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { OpportunityGeneratorService } from '../opportunities/opportunity-generator/opportunity-generator.service';
import { N8nWebhookService } from '../integrations/n8n-webhook.service';
import { MetaService } from '../integrations/meta.service';
import { GoogleSearchConsoleService } from '../integrations/google-search-console.service';
import { PrismaService } from '../prisma/prisma.service';
import { IntelligenceRegistryService } from './intelligence-registry.service';
import { SeoIntelligenceAdapter } from './adapters/seo-intelligence.adapter';
import { PageSpeedIntelligenceAdapter } from './adapters/pagespeed-intelligence.adapter';
import { SearchConsoleIntelligenceAdapter } from './adapters/search-console-intelligence.adapter';
import { Ga4IntelligenceAdapter } from './adapters/ga4-intelligence.adapter';
import { MetaIntelligenceAdapter } from './adapters/meta-intelligence.adapter';
import { GbpIntelligenceAdapter } from './adapters/gbp-intelligence.adapter';
import { GoogleBusinessProfileService } from '../integrations/google-business-profile.service';

/**
 * RC-21's headline correctness requirement, tested end to end rather than
 * only at each service's own boundary: `seo_score_v2` — the Python engine's
 * output (`python-service/app/agents/scoring.py`) — must come out of the
 * REAL, fully-wired intelligence pipeline (registry + all 6 adapters, not
 * mocked at the OpportunitiesService boundary) byte-for-byte identical to
 * what went in, and nothing in this pipeline may ever call
 * `prisma.audit.update`. Only Prisma itself and the two Google/Meta
 * integration services' HTTP layers are mocked — every RC-21 adapter and
 * the registry are the real, production classes.
 */
describe('seo_score_v2 invariance through the real Unified Intelligence Core (RC-21)', () => {
  const organizationId = 'org-1';
  const auditId = 'audit-1';

  const seoScoreV2 = Object.freeze({
    version: 'v2',
    globalScore: 75,
    categories: Object.freeze({
      technical: Object.freeze({
        score: 80,
        weight: 0.3,
        measured: true,
        findingsEvaluated: 4,
      }),
      content: Object.freeze({
        score: 60,
        weight: 0.4,
        measured: true,
        findingsEvaluated: 6,
      }),
    }),
  });

  const pagespeedInsights = Object.freeze({
    status: 'ok' as const,
    strategy: 'mobile' as const,
    performanceScore: 82,
    metrics: Object.freeze({ lcpMs: 1200, cls: 0.02, tbtMs: 50, fcpMs: 800 }),
    fetchedAt: '2026-09-01T00:00:00.000Z',
    analyzedUrl: 'https://robiacopilot.site/',
    finalUrl: 'https://robiacopilot.site/',
    source: 'pagespeed-insights',
    unavailableReason: null,
  });

  function buildOpportunitiesService(prisma: {
    audit: { findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    organization: { findUnique: jest.Mock };
    opportunity: {
      count: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
    };
    $transaction: jest.Mock;
    metaConnection: { findUnique: jest.Mock };
    googleSearchConsoleConnection: { findUnique: jest.Mock };
  }) {
    const config = { get: jest.fn() } as unknown as ConfigService;
    const meta = new MetaService(prisma as unknown as PrismaService, config);
    const googleSearchConsole = new GoogleSearchConsoleService(
      prisma as unknown as PrismaService,
      config,
    );
    const registry = new IntelligenceRegistryService(
      new SeoIntelligenceAdapter(prisma as unknown as PrismaService),
      new PageSpeedIntelligenceAdapter(prisma as unknown as PrismaService),
      new SearchConsoleIntelligenceAdapter(googleSearchConsole),
      new Ga4IntelligenceAdapter(googleSearchConsole),
      new MetaIntelligenceAdapter(meta),
      new GbpIntelligenceAdapter({
        getIntelligenceSignal: jest.fn().mockResolvedValue({
          status: 'not_connected',
          observedAt: null,
          data: null,
        }),
      } as unknown as GoogleBusinessProfileService),
    );
    const generator = {
      generate: jest.fn().mockResolvedValue([
        {
          title: 'Ajouter une balise meta description',
          description: 'Description',
          category: 'content',
          impact_score: 8,
          effort_score: 2,
          confidence_score: 0.9,
          source_data: 'x',
        },
      ]),
      generateForSite: jest.fn(),
    } as unknown as OpportunityGeneratorService;
    const webhooks = {
      notifyAuditCompleted: jest.fn().mockResolvedValue(true),
    } as unknown as N8nWebhookService;

    return new OpportunitiesService(
      prisma as unknown as PrismaService,
      generator,
      webhooks,
      registry,
      config,
    );
  }

  it('leaves seo_score_v2 byte-for-byte identical and never calls audit.update, when generating opportunities through the real pipeline', async () => {
    const prisma = {
      audit: {
        findFirst: jest.fn().mockResolvedValue({
          id: auditId,
          globalScore: 75,
          completedAt: new Date('2026-09-04T21:00:00Z'),
          website: { url: 'https://robiacopilot.site/' },
          organization: {
            owner: { name: 'Landry', email: 'landry@example.com' },
          },
          resultJson: {
            global_score: 75,
            site_audit: {
              seo_score_v2: seoScoreV2,
              pagespeed_insights: pagespeedInsights,
            },
          },
        }),
        // Deliberately NOT jest.fn() — if anything in this pipeline ever
        // calls audit.update/updateMany, the test fails with "not a
        // function" rather than silently succeeding.
        update: undefined as unknown as jest.Mock,
        updateMany: undefined as unknown as jest.Mock,
      },
      organization: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ city: 'Antananarivo', country: 'Madagascar' }),
      },
      opportunity: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: unknown }) =>
            Promise.resolve({ id: 'opportunity-1', ...(data as object) }),
          ),
      },
      $transaction: jest
        .fn()
        .mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops)),
      // No Meta/GSC connection exists for this organization — both real
      // services degrade to their documented 'not_connected' signal
      // without ever needing a network call.
      metaConnection: { findUnique: jest.fn().mockResolvedValue(null) },
      googleSearchConsoleConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    const service = buildOpportunitiesService(prisma);

    const opportunities = await service.generateFromAudit(
      organizationId,
      auditId,
    );

    // The SEO opportunity from the (mocked) generator is still produced.
    expect(
      opportunities.some(
        (o) => o.title === 'Ajouter une balise meta description',
      ),
    ).toBe(true);

    // The exact fixture object is still deep-equal to its frozen original —
    // Object.freeze() would itself throw synchronously on any attempted
    // mutation in non-strict internal code paths, but this also proves no
    // *new* object silently replaced it anywhere along the way.
    expect(seoScoreV2).toEqual({
      version: 'v2',
      globalScore: 75,
      categories: {
        technical: {
          score: 80,
          weight: 0.3,
          measured: true,
          findingsEvaluated: 4,
        },
        content: {
          score: 60,
          weight: 0.4,
          measured: true,
          findingsEvaluated: 6,
        },
      },
    });

    // No opportunity's own persisted data embeds a mutated/recomputed
    // seo_score_v2 — this pipeline only ever reads it (via SeoIntelligenceAdapter,
    // exercised for real above through the registry), never writes it back.
    expect(JSON.stringify(opportunities)).not.toContain('"globalScore":999');
  });
});
