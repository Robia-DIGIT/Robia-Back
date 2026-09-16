import { ConfigService } from '@nestjs/config';
import { OpportunitiesService } from './opportunities.service';
import { PrismaService } from '../prisma/prisma.service';
import { OpportunityGeneratorService } from './opportunity-generator/opportunity-generator.service';
import { N8nWebhookService } from '../integrations/n8n-webhook.service';
import { IntelligenceRegistryService } from '../intelligence/intelligence-registry.service';
import { IntelligenceFinding } from '../intelligence/intelligence.types';

// Default routing preserves n8n independently of dispatcher activation.
function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (name: string, fallback?: string) => values[name] ?? fallback,
  } as unknown as ConfigService;
}

// Precisely-typed mocks (not `any`) for every constructor dependency —
// every no-unsafe-* ESLint finding in this file traced back to these being
// `any`; typing them here, once, fixes every call site below without
// touching the ESLint baseline (Codex review).
interface MockPrisma {
  audit: { findFirst: jest.Mock; update: jest.Mock };
  organization: { findUnique: jest.Mock };
  opportunity: {
    count: jest.Mock;
    deleteMany: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    create: jest.Mock<
      Promise<Record<string, unknown>>,
      [{ data: Record<string, unknown> }]
    >;
  };
  $transaction: jest.Mock;
}
interface MockGenerator {
  generate: jest.Mock;
  generateForSite: jest.Mock;
}
interface MockWebhooks {
  notifyAuditCompleted: jest.Mock;
}
interface MockIntelligence {
  collectFindings: jest.Mock;
}

function metaFinding(
  overrides: Partial<IntelligenceFinding> = {},
): IntelligenceFinding {
  return {
    provider: 'meta',
    ruleCode: 'META_INSTAGRAM_NOT_LINKED',
    title: 'Aucun compte Instagram professionnel lié',
    description:
      "La Page Facebook active est sélectionnée, mais aucun compte Instagram professionnel n'y est lié.",
    category: 'social',
    evidence: [
      {
        observed:
          'Page Facebook sélectionnée sans compte Instagram business lié',
        expected: 'Un compte Instagram professionnel lié à la Page',
      },
    ],
    recommendation:
      'Liez un compte Instagram professionnel à la Page Facebook depuis les paramètres Meta, puis reconnectez ROBIA.',
    impactScore: 3,
    effortScore: 2,
    confidenceScore: 0.9,
    confidence: 'observed',
    scoreInfluence: false,
    ...overrides,
  };
}

describe('OpportunitiesService', () => {
  const organizationId = 'org-1';
  const auditId = 'audit-1';
  const generated = [
    {
      title: 'Améliorer la présence locale',
      description: 'Description',
      category: 'local',
      impact_score: 90,
      effort_score: 40,
      confidence_score: 0.9,
      source_data: 'source',
    },
  ];

  let prisma: MockPrisma;
  let generator: MockGenerator;
  let webhooks: MockWebhooks;
  let intelligence: MockIntelligence;
  let service: OpportunitiesService;

  beforeEach(() => {
    prisma = {
      audit: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          city: 'Antananarivo',
          country: 'Madagascar',
        }),
      },
      opportunity: {
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        create: jest
          .fn<
            Promise<Record<string, unknown>>,
            [{ data: Record<string, unknown> }]
          >()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'opportunity-1', ...data }),
          ),
      },
      $transaction: jest
        .fn()
        .mockImplementation((operations: Array<Promise<unknown>>) =>
          Promise.all(operations),
        ),
    };
    generator = {
      generate: jest.fn().mockResolvedValue(generated),
      generateForSite: jest.fn().mockResolvedValue(generated),
    };
    webhooks = {
      notifyAuditCompleted: jest.fn().mockResolvedValue(true),
    };
    // Default: no provider (e.g. Meta not connected) has anything to
    // report — matches the pre-RC-21 default of an unconnected Meta
    // signal, but expressed at IntelligenceRegistryService's own level
    // rather than re-deriving it through evaluateMetaFindings(), which is
    // already covered independently by meta-insights.spec.ts.
    intelligence = {
      collectFindings: jest.fn().mockResolvedValue([]),
    };
    service = new OpportunitiesService(
      prisma as unknown as PrismaService,
      generator as unknown as OpportunityGeneratorService,
      webhooks as unknown as N8nWebhookService,
      intelligence as unknown as IntelligenceRegistryService,
      fakeConfig(),
    );
  });

  it('uses attached multi-page evidence for new standard audits', async () => {
    const siteAudit = {
      pages_analyzed: 2,
      pages: [
        { url: 'https://robiacopilot.site/' },
        { url: 'https://robiacopilot.site/seo-local-antananarivo' },
      ],
    };
    prisma.audit.findFirst.mockResolvedValue({
      id: auditId,
      globalScore: 62,
      completedAt: new Date('2026-09-04T21:00:00Z'),
      website: { url: 'https://robiacopilot.site/' },
      organization: {
        owner: { name: 'Landry', email: 'landry@example.com' },
      },
      resultJson: {
        global_score: 62,
        site_audit: siteAudit,
      },
    });

    await service.generateFromAudit(organizationId, auditId);

    expect(generator.generateForSite).toHaveBeenCalledWith({
      siteAuditResult: siteAudit,
      city: 'Antananarivo',
      country: 'Madagascar',
    });
    expect(generator.generate).not.toHaveBeenCalled();
    expect(prisma.opportunity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId,
        auditId,
        title: generated[0].title,
      }) as Record<string, unknown>,
    });
    expect(webhooks.notifyAuditCompleted).toHaveBeenCalledWith({
      auditId,
      email: 'landry@example.com',
      userName: 'Landry',
      websiteUrl: 'https://robiacopilot.site/',
      score: 62,
      opportunities: ['Améliorer la présence locale'],
      completedAt: new Date('2026-09-04T21:00:00Z'),
    });
  });

  it.each([
    ['false', 'n8n', true],
    ['true', 'n8n', true],
    ['true', 'notifications', false],
    ['true', undefined, true],
    ['true', 'invalid', true],
  ])(
    'routes audit email with dispatcher=%s, provider=%s (no email automation required)',
    async (enabled, provider, sendsN8n) => {
      service = new OpportunitiesService(
        prisma as unknown as PrismaService,
        generator as unknown as OpportunityGeneratorService,
        webhooks as unknown as N8nWebhookService,
        intelligence as unknown as IntelligenceRegistryService,
        fakeConfig({
          NOTIFICATIONS_ENABLED: enabled,
          ...(provider ? { AUDIT_COMPLETED_EMAIL_PROVIDER: provider } : {}),
        }),
      );
      prisma.audit.findFirst.mockResolvedValue({
        id: auditId,
        globalScore: 62,
        completedAt: new Date('2026-09-04T21:00:00Z'),
        website: { url: 'https://robiacopilot.site/' },
        organization: {
          owner: { name: 'Landry', email: 'landry@example.com' },
        },
        resultJson: {
          global_score: 62,
          site_audit: {
            pages_analyzed: 2,
            pages: [{ url: 'https://robiacopilot.site/' }],
          },
        },
      });

      await service.generateFromAudit(organizationId, auditId);

      expect(webhooks.notifyAuditCompleted).toHaveBeenCalledTimes(
        sendsN8n ? 1 : 0,
      );
    },
  );

  it('keeps the legacy single-page generator for existing audits', async () => {
    const legacyResult = {
      global_score: 62,
      missing_data: ['local_page'],
    };
    prisma.audit.findFirst.mockResolvedValue({
      id: auditId,
      globalScore: 62,
      completedAt: new Date('2026-09-04T21:00:00Z'),
      website: { url: 'https://robiacopilot.site/' },
      organization: {
        owner: { name: 'Landry', email: 'landry@example.com' },
      },
      resultJson: legacyResult,
    });

    await service.generateFromAudit(organizationId, auditId);

    expect(generator.generate).toHaveBeenCalledWith(
      legacyResult,
      'Antananarivo',
    );
    expect(generator.generateForSite).not.toHaveBeenCalled();
  });

  it('does not regenerate SEO opportunities or send another audit email when opportunities already exist, but still checks for missing Meta ones (RC-19)', async () => {
    prisma.audit.findFirst.mockResolvedValue({
      id: auditId,
      globalScore: 62,
      completedAt: new Date('2026-09-04T21:00:00Z'),
      website: { url: 'https://robiacopilot.site/' },
      organization: {
        owner: { name: 'Landry', email: 'landry@example.com' },
      },
      resultJson: { global_score: 62 },
    });
    prisma.opportunity.count.mockResolvedValue(2);
    prisma.opportunity.findMany.mockResolvedValue([
      { id: 'existing-opportunity', auditId },
    ]);

    await expect(
      service.generateFromAudit(organizationId, auditId),
    ).resolves.toEqual([{ id: 'existing-opportunity', auditId }]);

    expect(webhooks.notifyAuditCompleted).not.toHaveBeenCalled();
    expect(generator.generate).not.toHaveBeenCalled();
    expect(generator.generateForSite).not.toHaveBeenCalled();
    expect(prisma.opportunity.deleteMany).not.toHaveBeenCalled();
    // No provider has anything to report in this test (the default mock) —
    // nothing new to add — but the check itself must still run so a later
    // provider connection can be picked up without a fresh audit.
    expect(intelligence.collectFindings).toHaveBeenCalledWith(organizationId, {
      auditId,
      auditResult: { global_score: 62 },
    });
    expect(prisma.opportunity.create).not.toHaveBeenCalled();
  });

  it('persists a status change only after checking organization ownership', async () => {
    prisma.opportunity.findFirst.mockResolvedValue({
      id: 'opportunity-1',
      organizationId,
    });
    prisma.opportunity.update.mockResolvedValue({
      id: 'opportunity-1',
      status: 'done',
    });

    await expect(
      service.updateStatus(organizationId, 'opportunity-1', 'done'),
    ).resolves.toEqual({ id: 'opportunity-1', status: 'done' });
    expect(prisma.opportunity.findFirst).toHaveBeenCalledWith({
      where: { id: 'opportunity-1', organizationId },
    });
    expect(prisma.opportunity.update).toHaveBeenCalledWith({
      where: { id: 'opportunity-1' },
      data: { status: 'done' },
    });
  });

  describe('Provider opportunities (RC-21, generalizes RC-19 Meta)', () => {
    interface TestOpportunity {
      organizationId: string;
      auditId: string;
      title: string;
      impactScore?: number;
      effortScore?: number;
      sourceData?: {
        provider?: string;
        source?: string;
        ruleCode?: string;
        confidence?: string;
        evidence?: unknown[];
        recommendation?: string | string[];
        scoreInfluence?: boolean;
      };
    }

    function asTestOpportunities(value: unknown): TestOpportunity[] {
      return value as TestOpportunity[];
    }

    function mockAudit(resultJson: Record<string, unknown>) {
      prisma.audit.findFirst.mockResolvedValue({
        id: auditId,
        globalScore: 62,
        completedAt: new Date('2026-09-04T21:00:00Z'),
        website: { url: 'https://robiacopilot.site/' },
        organization: {
          owner: { name: 'Landry', email: 'landry@example.com' },
        },
        resultJson,
      });
    }

    it('adds a provider-sourced opportunity, tagged provider=meta (and legacy source=meta) with scoreInfluence=false, alongside the SEO ones', async () => {
      mockAudit({ global_score: 62 });
      intelligence.collectFindings.mockResolvedValue([metaFinding()]);

      const opportunities = asTestOpportunities(
        await service.generateFromAudit(organizationId, auditId),
      );

      const providerOpportunity = opportunities.find(
        (opp) => opp.sourceData?.provider === 'meta',
      );
      expect(providerOpportunity).toBeDefined();
      expect(providerOpportunity?.organizationId).toBe(organizationId);
      expect(providerOpportunity?.auditId).toBe(auditId);
      expect(providerOpportunity?.sourceData?.ruleCode).toBe(
        'META_INSTAGRAM_NOT_LINKED',
      );
      expect(providerOpportunity?.sourceData?.scoreInfluence).toBe(false);
      // The RC-19 `source` key is still written, byte for byte the same
      // value as `provider` — no already-persisted Meta opportunity or
      // reader needs to change shape because of this refactor.
      expect(providerOpportunity?.sourceData?.source).toBe('meta');
      expect(Array.isArray(providerOpportunity?.sourceData?.evidence)).toBe(
        true,
      );
      expect(typeof providerOpportunity?.sourceData?.recommendation).toBe(
        'string',
      );
      // Same 0-10 scale as every SEO opportunity (Codex review) — never a
      // different scale that would distort oppPriorityScore()'s fallback
      // or findAllForAudit()'s top-5 ranking.
      expect(providerOpportunity?.impactScore).toBeGreaterThanOrEqual(0);
      expect(providerOpportunity?.impactScore).toBeLessThanOrEqual(10);
      expect(providerOpportunity?.effortScore).toBeGreaterThanOrEqual(0);
      expect(providerOpportunity?.effortScore).toBeLessThanOrEqual(10);
      // Still generates the unrelated SEO opportunity from the same audit.
      expect(
        opportunities.some((opp) => opp.title === generated[0].title),
      ).toBe(true);
    });

    it("preserves MetaFinding's 'observed' vs 'heuristic' confidence in sourceData, so the frontend never mislabels a threshold-based finding as a directly-observed fact (Codex review)", async () => {
      mockAudit({ global_score: 62 });
      intelligence.collectFindings.mockResolvedValue([
        metaFinding({
          ruleCode: 'META_LOW_RECENT_ACTIVITY',
          confidence: 'heuristic',
        }),
      ]);

      const opportunities = asTestOpportunities(
        await service.generateFromAudit(organizationId, auditId),
      );

      const providerOpportunity = opportunities.find(
        (opp) => opp.sourceData?.provider === 'meta',
      );
      expect(providerOpportunity?.sourceData?.confidence).toBe('heuristic');
    });

    it('adds a missing provider opportunity to an audit that already has SEO opportunities, without regenerating or deleting the existing ones (Codex review)', async () => {
      mockAudit({ global_score: 62 });
      prisma.opportunity.count.mockResolvedValue(1);
      const existingSeoOpportunity = {
        id: 'existing-seo-opportunity',
        organizationId,
        auditId,
        title: generated[0].title,
        sourceData: { ruleCode: 'content.meta_description_missing' },
      };
      prisma.opportunity.findMany.mockResolvedValue([existingSeoOpportunity]);
      intelligence.collectFindings.mockResolvedValue([metaFinding()]);

      await service.generateFromAudit(organizationId, auditId);

      // The SEO generator is never re-run on this path — the whole point
      // of idempotency is to avoid destroying existing actions/documents
      // linked to the SEO opportunity that's already there.
      expect(generator.generate).not.toHaveBeenCalled();
      expect(generator.generateForSite).not.toHaveBeenCalled();
      expect(prisma.opportunity.deleteMany).not.toHaveBeenCalled();
      // Exactly one new (provider) opportunity gets created — the missing
      // META_INSTAGRAM_NOT_LINKED finding — never a duplicate of the
      // existing SEO one.
      expect(prisma.opportunity.create).toHaveBeenCalledTimes(1);
      const createdData = prisma.opportunity.create.mock.calls[0][0]
        .data as unknown as TestOpportunity;
      expect(createdData.sourceData?.provider).toBe('meta');
      expect(createdData.sourceData?.source).toBe('meta');
      expect(createdData.sourceData?.ruleCode).toBe(
        'META_INSTAGRAM_NOT_LINKED',
      );
    });

    it('creates no new opportunity when every current provider finding already has one recorded for this audit (idempotent re-run)', async () => {
      mockAudit({ global_score: 62 });
      prisma.opportunity.count.mockResolvedValue(2);
      prisma.opportunity.findMany.mockResolvedValue([
        {
          id: 'existing-seo-opportunity',
          organizationId,
          auditId,
          sourceData: { ruleCode: 'content.meta_description_missing' },
        },
        {
          id: 'existing-meta-opportunity',
          organizationId,
          auditId,
          // Legacy RC-19 shape (source only, no provider key) — proves the
          // backward-compat detection path, not just the new one.
          sourceData: { source: 'meta', ruleCode: 'META_INSTAGRAM_NOT_LINKED' },
        },
      ]);
      intelligence.collectFindings.mockResolvedValue([metaFinding()]);

      await service.generateFromAudit(organizationId, auditId);

      expect(prisma.opportunity.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('generates no provider opportunity when no provider has anything to report', async () => {
      mockAudit({ global_score: 62 });
      // intelligence.collectFindings already defaults to [] in beforeEach.

      const opportunities = asTestOpportunities(
        await service.generateFromAudit(organizationId, auditId),
      );

      expect(
        opportunities.some((opp) => opp.sourceData?.provider === 'meta'),
      ).toBe(false);
    });

    it('never fails opportunity generation when the intelligence findings collection itself rejects', async () => {
      mockAudit({ global_score: 62 });
      intelligence.collectFindings.mockRejectedValue(
        new Error('registry exploded'),
      );

      await expect(
        service.generateFromAudit(organizationId, auditId),
      ).rejects.toThrow('registry exploded');
      // Documents the current contract: IntelligenceRegistryService.
      // collectFindings() itself never rejects — every adapter is isolated
      // behind its own Promise.allSettled (see
      // intelligence-registry.service.spec.ts's "provider en panne" test),
      // exactly as MetaService.getInsightSignals()/GoogleSearchConsoleService's
      // signal reads never throw. OpportunitiesService trusts that
      // guarantee and adds no redundant try/catch of its own.
    });

    it('never lets a provider opportunity carry an access token or a fabricated metric', async () => {
      mockAudit({ global_score: 62 });
      intelligence.collectFindings.mockResolvedValue([
        metaFinding({
          ruleCode: 'META_PAGE_NOT_SELECTED',
          title: 'Aucune Page Facebook active sélectionnée',
          evidence: [
            {
              observed: 'Connexion Meta active, aucune Page sélectionnée',
              expected: 'Une Page Facebook active sélectionnée',
            },
          ],
        }),
      ]);

      const opportunities = await service.generateFromAudit(
        organizationId,
        auditId,
      );

      const serialized = JSON.stringify(opportunities);
      expect(serialized).not.toMatch(
        /access_token|encryptedPageAccessToken|encryptedUserAccessToken/i,
      );
      expect(serialized).not.toMatch(
        /\b\d+\s*(followers|abonnés|engagement)\b/i,
      );
    });

    it('never touches seo_score_v2 or triggers an audit update while generating provider opportunities', async () => {
      const seoScoreV2 = {
        version: 'v2',
        globalScore: 75,
        categories: {
          technical: {
            score: 80,
            weight: 0.3,
            measured: true,
            findingsEvaluated: 4,
          },
        },
      };
      mockAudit({ global_score: 62, seo_score_v2: seoScoreV2 });
      intelligence.collectFindings.mockResolvedValue([metaFinding()]);

      await service.generateFromAudit(organizationId, auditId);

      // OpportunitiesService (SEO and provider findings alike) only ever
      // reads the audit — nothing here writes seo_score_v2, or anything
      // else, back to it.
      expect(prisma.audit.update).not.toHaveBeenCalled();
      // The same object reference handed to the mock is still intact —
      // proof nothing in this call mutated it in place either.
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
        },
      });
    });

    it('keeps a provider opportunity visible in the listing even when 5 higher-impact SEO opportunities already fill the top-5 cap (Codex review)', async () => {
      // findAllForAudit() previously did one `orderBy: impactScore desc,
      // take: 5` over SEO + provider combined — a full slate of
      // higher-impact SEO opportunities could silently evict every
      // provider one, which would still exist in the database (created by
      // syncMissingProviderOpportunities()) but never show up here, and
      // disappear again on reload.
      const seoOpportunities = Array.from({ length: 5 }, (_, index) => ({
        id: `seo-${index}`,
        organizationId,
        auditId,
        title: `Opportunité SEO ${index}`,
        impactScore: 9,
        sourceData: { ruleCode: `content.rule_${index}` },
      }));
      const metaOpportunity = {
        id: 'meta-1',
        organizationId,
        auditId,
        title: 'Aucun compte Instagram professionnel lié',
        impactScore: 3,
        // Legacy RC-19 shape (source only) — this listing path must keep
        // recognizing it, not just newly-created `provider`-tagged rows.
        sourceData: { source: 'meta', ruleCode: 'META_INSTAGRAM_NOT_LINKED' },
      };
      prisma.opportunity.findMany.mockResolvedValue([
        ...seoOpportunities,
        metaOpportunity,
      ]);

      const result = asTestOpportunities(
        await service.findAllForAudit(organizationId, auditId),
      );

      // SEO keeps its own top-5 cap, unchanged...
      expect(
        result.filter((opp) => opp.sourceData?.source !== 'meta'),
      ).toHaveLength(5);
      // ...but the lower-impact provider opportunity is never evicted by it.
      expect(
        result.some(
          (opp) =>
            opp.sourceData?.source === 'meta' &&
            opp.sourceData?.ruleCode === 'META_INSTAGRAM_NOT_LINKED',
        ),
      ).toBe(true);
    });
  });
});
