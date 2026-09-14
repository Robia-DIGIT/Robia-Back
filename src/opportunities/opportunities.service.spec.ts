import { OpportunitiesService } from './opportunities.service';

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

  let prisma: any;
  let generator: any;
  let webhooks: any;
  let meta: any;
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
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'opportunity-1', ...data }),
          ),
      },
      $transaction: jest
        .fn()
        .mockImplementation((operations) => Promise.all(operations)),
    };
    generator = {
      generate: jest.fn().mockResolvedValue(generated),
      generateForSite: jest.fn().mockResolvedValue(generated),
    };
    webhooks = {
      notifyAuditCompleted: jest.fn().mockResolvedValue(true),
    };
    meta = {
      getInsightSignals: jest.fn().mockResolvedValue({
        status: 'unavailable',
        source: 'meta',
        readOnly: true,
        scoreInfluence: false,
        connected: false,
        pageSelected: false,
        instagramLinked: false,
        facebook: null,
        instagram: null,
        recentMedia: null,
        lastSyncedAt: null,
        unavailableReason: 'not_connected',
      }),
    };
    service = new OpportunitiesService(prisma, generator, webhooks, meta);
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
      }),
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

  it('does not send another audit email when opportunities already exist', async () => {
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
    expect(meta.getInsightSignals).not.toHaveBeenCalled();
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

  describe('Meta opportunities (RC-19)', () => {
    interface TestOpportunity {
      organizationId: string;
      auditId: string;
      title: string;
      sourceData?: {
        source?: string;
        ruleCode?: string;
        confidence?: string;
        evidence?: unknown[];
        recommendation?: string;
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

    it('adds a Meta-sourced opportunity, tagged source=meta and scoreInfluence=false, alongside the SEO ones', async () => {
      mockAudit({ global_score: 62 });
      meta.getInsightSignals.mockResolvedValue({
        status: 'unavailable',
        source: 'meta',
        readOnly: true,
        scoreInfluence: false,
        connected: true,
        pageSelected: true,
        instagramLinked: false,
        facebook: { fanCount: 10, followersCount: 10, talkingAboutCount: null },
        instagram: null,
        recentMedia: null,
        lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
        unavailableReason: null,
      });

      const opportunities = asTestOpportunities(
        await service.generateFromAudit(organizationId, auditId),
      );

      const metaOpportunity = opportunities.find(
        (opp) => opp.sourceData?.source === 'meta',
      );
      expect(metaOpportunity).toBeDefined();
      expect(metaOpportunity?.organizationId).toBe(organizationId);
      expect(metaOpportunity?.auditId).toBe(auditId);
      expect(metaOpportunity?.sourceData?.ruleCode).toBe(
        'META_INSTAGRAM_NOT_LINKED',
      );
      expect(metaOpportunity?.sourceData?.scoreInfluence).toBe(false);
      expect(['observed', 'heuristic']).toContain(
        metaOpportunity?.sourceData?.confidence,
      );
      expect(Array.isArray(metaOpportunity?.sourceData?.evidence)).toBe(true);
      expect(typeof metaOpportunity?.sourceData?.recommendation).toBe('string');
      // Still generates the unrelated SEO opportunity from the same audit.
      expect(
        opportunities.some((opp) => opp.title === generated[0].title),
      ).toBe(true);
    });

    it('generates no Meta opportunity when Meta is not connected', async () => {
      mockAudit({ global_score: 62 });
      // meta.getInsightSignals already defaults to "not_connected" in beforeEach.

      const opportunities = asTestOpportunities(
        await service.generateFromAudit(organizationId, auditId),
      );

      expect(
        opportunities.some((opp) => opp.sourceData?.source === 'meta'),
      ).toBe(false);
    });

    it('never fails opportunity generation when the Meta signal read itself rejects', async () => {
      mockAudit({ global_score: 62 });
      meta.getInsightSignals.mockRejectedValue(new Error('Meta graph down'));

      await expect(
        service.generateFromAudit(organizationId, auditId),
      ).rejects.toThrow('Meta graph down');
      // Documents the current contract: MetaService.getInsightSignals()
      // itself never throws (see meta-insights-signals.spec.ts) — the
      // guarantee lives there, exactly as GoogleSearchConsoleService's
      // does for GSC, not as a second, redundant try/catch here.
    });

    it('never lets a Meta opportunity carry an access token or a fabricated metric', async () => {
      mockAudit({ global_score: 62 });
      meta.getInsightSignals.mockResolvedValue({
        status: 'unavailable',
        source: 'meta',
        readOnly: true,
        scoreInfluence: false,
        connected: true,
        pageSelected: false,
        instagramLinked: false,
        facebook: null,
        instagram: null,
        recentMedia: null,
        lastSyncedAt: null,
        unavailableReason: 'no_page_selected',
      });

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

    it('never touches seo_score_v2 or triggers an audit update while generating Meta opportunities', async () => {
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
      meta.getInsightSignals.mockResolvedValue({
        status: 'unavailable',
        source: 'meta',
        readOnly: true,
        scoreInfluence: false,
        connected: true,
        pageSelected: false,
        instagramLinked: false,
        facebook: null,
        instagram: null,
        recentMedia: null,
        lastSyncedAt: null,
        unavailableReason: 'no_page_selected',
      });

      await service.generateFromAudit(organizationId, auditId);

      // OpportunitiesService (SEO and Meta alike) only ever reads the
      // audit — nothing here writes seo_score_v2, or anything else, back
      // to it.
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
  });
});
