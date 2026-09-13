import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { AuditsService } from './audits.service';
import { GoogleSearchConsoleService } from '../integrations/google-search-console.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditRunnerService } from './audit-runner/audit-runner.service';

describe('AuditsService', () => {
  const organizationId = 'org-1';
  const websiteId = 'website-1';
  const auditId = 'audit-1';

  let prisma: any;
  let auditRunner: any;
  let googleSearchConsole: { getSearchConsoleSignalsForAudit: jest.Mock };
  let logger: { assign: jest.Mock };
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

  const searchConsoleSignals = {
    status: 'unavailable',
    source: 'search_console',
    siteUrl: null,
    period: null,
    summary: null,
    lastSyncedAt: null,
    unavailableReason: 'not_connected',
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
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
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
    googleSearchConsole = {
      getSearchConsoleSignalsForAudit: jest
        .fn()
        .mockResolvedValue(searchConsoleSignals),
    };
    logger = { assign: jest.fn() };
    service = new AuditsService(
      prisma,
      auditRunner,
      googleSearchConsole as unknown as GoogleSearchConsoleService,
      logger as unknown as PinoLogger,
    );
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
    expect(auditRunner.runSiteAudit.mock.invocationCallOrder[0]).toBeLessThan(
      auditRunner.runAudit.mock.invocationCallOrder[0],
    );
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
            google_search_console: searchConsoleSignals,
          }),
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(
      googleSearchConsole.getSearchConsoleSignalsForAudit,
    ).toHaveBeenCalledWith(organizationId);
    expect(result.status).toBe('completed');
    expect(logger.assign).toHaveBeenCalledWith({ auditId });
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
    expect(
      googleSearchConsole.getSearchConsoleSignalsForAudit,
    ).not.toHaveBeenCalled();
    expect(prisma.audit.update).toHaveBeenCalledWith({
      where: { id: auditId },
      data: {
        status: 'failed',
        errorMessage: 'Audit multi-pages terminé sans page accessible',
      },
    });
    expect(result.status).toBe('failed');
  });

  it('completes the audit with an unavailable Search Console signal when its underlying reads fail — not a failed audit', async () => {
    // End-to-end proof (real GoogleSearchConsoleService, not a mock of it):
    // a transient DB failure while collecting the GSC side-signal must not
    // abort an otherwise-successful audit. See getSearchConsoleSignalsForAudit's
    // own unit tests in google-search-console.service.spec.ts for the same
    // guarantee isolated to that method.
    const gscPrisma = {
      googleSearchConsoleConnection: {
        findUnique: jest
          .fn()
          .mockRejectedValue(new Error('connection refused')),
      },
      googleSearchConsoleDailyMetric: { findMany: jest.fn() },
    } as unknown as PrismaService;
    const realGoogleSearchConsole = new GoogleSearchConsoleService(gscPrisma, {
      get: jest.fn(),
    } as unknown as ConfigService);
    // Fresh, precisely-typed mocks for prisma/auditRunner here (rather
    // than reusing the file's shared `any`-typed ones) so the cast this
    // test needs is a genuine narrowing the linter accepts, not a no-op
    // it flags as unnecessary.
    const auditPrisma = {
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
        update: jest
          .fn()
          .mockImplementation(({ data }: any) =>
            Promise.resolve({ id: auditId, ...data }),
          ),
      },
      webPage: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const auditRunnerForThisTest = {
      runSiteAudit: jest.fn().mockResolvedValue(siteResult),
      runAudit: jest.fn().mockResolvedValue(scoreResult),
    } as unknown as AuditRunnerService;
    const loggerForThisTest = { assign: jest.fn() } as unknown as PinoLogger;
    service = new AuditsService(
      auditPrisma,
      auditRunnerForThisTest,
      realGoogleSearchConsole,
      loggerForThisTest,
    );

    const result: any = await service.run(organizationId, websiteId);

    expect(result.status).toBe('completed');
    expect(result.resultJson.google_search_console).toEqual({
      status: 'unavailable',
      source: 'search_console',
      siteUrl: null,
      period: null,
      summary: null,
      lastSyncedAt: null,
      unavailableReason: 'temporarily_unavailable',
    });
  });
});
