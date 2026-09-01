import { AuditsService } from './audits.service';

describe('AuditsService', () => {
  const organizationId = 'org-1';
  const websiteId = 'website-1';
  const auditId = 'audit-1';

  let prisma: any;
  let auditRunner: any;
  let service: AuditsService;

  const page = {
    url: 'https://robiacopilot.site/seo-local-antananarivo',
    accessible: true,
    status_code: 200,
    title: 'SEO local Antananarivo',
    meta_description: 'Description',
    h1: ['SEO local'],
    h2: [],
    h3: [],
    canonical: null,
    meta_robots: null,
    word_count: 500,
    images_count: 1,
    images_without_alt: 0,
    internal_links_count: 2,
    external_links_count: 0,
    structured_data_types: ['WebPage'],
    og_tags_present: ['og:title'],
    top_keywords: ['antananarivo'],
    business_address: null,
    business_latitude: null,
    business_longitude: null,
    social_links: {},
    js_rendering_used: false,
    js_rendering_suspected: false,
    main_content: 'Contenu local',
    error: null,
  };

  const siteResult = {
    base_url: 'https://robiacopilot.site',
    discovery_method: 'sitemap',
    pages_discovered: 1,
    pages_analyzed: 1,
    pages_failed: 0,
    pages_excluded: 0,
    pages_count: 1,
    pages_with_h1: 1,
    pages_without_h1: 0,
    pages_with_meta_description: 1,
    pages_without_meta_description: 0,
    pages_with_schema: 1,
    pages_without_schema: 0,
    pages_with_og: 1,
    pages_without_og: 0,
    avg_word_count: 500,
    business_address: null,
    business_latitude: null,
    business_longitude: null,
    location_precision: 'city',
    social_links: {},
    top_keywords: ['antananarivo'],
    findings: [],
    pages: [page],
    failed_urls: [],
  };

  const scoreResult = {
    global_score: 62,
    subscores: {
      local: 30,
      technical: 100,
      content: 90,
      performance: 90,
      ai_readiness: 0,
    },
    missing_data: [],
    summary: 'Résumé',
  };

  beforeEach(() => {
    prisma = {
      website: {
        findFirst: jest.fn().mockResolvedValue({
          id: websiteId,
          url: 'https://robiacopilot.site/',
        }),
      },
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          city: 'Antananarivo',
          sector: 'SaaS',
          country: 'Madagascar',
        }),
      },
      audit: {
        create: jest.fn().mockResolvedValue({ id: auditId }),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: auditId, ...data }),
        ),
      },
      webPage: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    auditRunner = {
      runSiteAudit: jest.fn().mockResolvedValue(siteResult),
      runAudit: jest.fn().mockResolvedValue(scoreResult),
    };
    service = new AuditsService(prisma, auditRunner);
  });

  it('crawls and persists site pages before completing the standard audit', async () => {
    const result = await service.run(organizationId, websiteId);

    expect(auditRunner.runSiteAudit).toHaveBeenCalledWith({
      websiteUrl: 'https://robiacopilot.site/',
      maxPages: 20,
      maxDepth: 2,
      city: 'Antananarivo',
      country: 'Madagascar',
    });
    expect(auditRunner.runAudit).toHaveBeenCalledWith({
      websiteUrl: 'https://robiacopilot.site/',
      sector: 'SaaS',
      city: 'Antananarivo',
      country: 'Madagascar',
    });
    expect(
      auditRunner.runSiteAudit.mock.invocationCallOrder[0],
    ).toBeLessThan(auditRunner.runAudit.mock.invocationCallOrder[0]);
    expect(prisma.webPage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          websiteId_url: {
            websiteId,
            url: page.url,
          },
        },
        create: expect.objectContaining({
          websiteId,
          url: page.url,
          status: 'crawled',
        }),
      }),
    );
    expect(prisma.audit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: auditId },
        data: expect.objectContaining({
          status: 'completed',
          globalScore: 62,
          resultJson: expect.objectContaining({
            global_score: 62,
            site_audit: siteResult,
          }),
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(result.status).toBe('completed');
  });

  it('marks the audit failed instead of completing with zero accessible pages', async () => {
    auditRunner.runSiteAudit.mockResolvedValue({
      ...siteResult,
      pages_analyzed: 0,
      pages: [],
    });

    const result = await service.run(organizationId, websiteId);

    expect(auditRunner.runAudit).not.toHaveBeenCalled();
    expect(prisma.webPage.upsert).not.toHaveBeenCalled();
    expect(prisma.audit.update).toHaveBeenCalledWith({
      where: { id: auditId },
      data: {
        status: 'failed',
        errorMessage: 'Audit multi-pages terminé sans page accessible',
      },
    });
    expect(result.status).toBe('failed');
  });
});
