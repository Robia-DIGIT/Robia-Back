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
  let service: OpportunitiesService;

  beforeEach(() => {
    prisma = {
      audit: {
        findFirst: jest.fn(),
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
    service = new OpportunitiesService(prisma, generator, webhooks);
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
    expect(prisma.opportunity.deleteMany).toHaveBeenCalledWith({
      where: { auditId },
    });
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

    await service.generateFromAudit(organizationId, auditId);

    expect(webhooks.notifyAuditCompleted).not.toHaveBeenCalled();
  });
});
