import { ActionItemsService } from './action-items.service';

describe('ActionItemsService', () => {
  const organizationId = 'org-1';
  const opportunityId = 'opp-1';
  const sourceData = {
    version: 2,
    severity: 'high',
    priorityScore: 86,
    summary: 'Deux pages sont sans H1.',
    affectedUrls: ['https://example.com/', 'https://example.com/service'],
    evidence: [
      {
        url: 'https://example.com/',
        observed: 'Aucun H1 détecté',
        expected: 'Un H1 principal clair',
      },
    ],
    recommendedSteps: [
      'Ajouter un H1 visible sur chaque page affectée.',
      "Relancer l'audit pour confirmer la correction.",
    ],
  };
  let prisma: any;
  let generator: any;
  let service: ActionItemsService;

  beforeEach(() => {
    prisma = {
      audit: { findFirst: jest.fn() },
      opportunity: { findFirst: jest.fn() },
      actionItem: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn((operations) => Promise.all(operations)),
    };
    generator = { generateFromOpportunity: jest.fn() };
    service = new ActionItemsService(prisma, generator);
  });

  it('uses ordered v2 recommendations instead of asking the LLM again', async () => {
    prisma.opportunity.findFirst.mockResolvedValue({
      id: opportunityId,
      title: 'Ajouter les titres H1 manquants',
      description: 'Le H1 structure la page.',
      impactScore: 7,
      sourceData,
    });
    prisma.actionItem.findMany.mockResolvedValue([]);
    prisma.actionItem.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: `action-${data.title}`, ...data, createdAt: new Date() }),
    );

    const result = await service.generateFromOpportunity(
      organizationId,
      opportunityId,
    );

    expect(generator.generateFromOpportunity).not.toHaveBeenCalled();
    expect(prisma.actionItem.create).toHaveBeenCalledTimes(2);
    expect(prisma.actionItem.create.mock.calls[0][0].data.title).toBe(
      sourceData.recommendedSteps[0],
    );
    expect(prisma.actionItem.create.mock.calls[1][0].data.title).toBe(
      sourceData.recommendedSteps[1],
    );
    expect(result[0]).toEqual(
      expect.objectContaining({
        title: sourceData.recommendedSteps[0],
        priority: 'Haute',
        priorityScore: 86,
        sequence: 1,
        description: 'Deux pages sont sans H1.',
        affectedUrls: sourceData.affectedUrls,
        validationCriteria:
          "Relancer l'audit et vérifier : Un H1 principal clair",
      }),
    );
    expect(result[1].sequence).toBe(2);
  });

  it('returns existing actions instead of creating duplicates', async () => {
    const existing = [
      {
        id: 'action-1',
        opportunityId,
        title: sourceData.recommendedSteps[0],
        createdAt: new Date(),
      },
    ];
    prisma.opportunity.findFirst.mockResolvedValue({
      id: opportunityId,
      title: 'Opportunity',
      description: 'Description',
      impactScore: 7,
      sourceData,
    });
    prisma.actionItem.findMany.mockResolvedValue(existing);

    const result = await service.generateFromOpportunity(
      organizationId,
      opportunityId,
    );

    expect(result[0]).toEqual(
      expect.objectContaining({ id: 'action-1', priority: 'Haute' }),
    );
    expect(generator.generateFromOpportunity).not.toHaveBeenCalled();
    expect(prisma.actionItem.create).not.toHaveBeenCalled();
  });

  it('only lists actions from the latest completed audit of the selected site', async () => {
    prisma.audit.findFirst.mockResolvedValue({ id: 'audit-latest' });
    prisma.actionItem.findMany.mockResolvedValue([
      {
        id: 'action-1',
        opportunityId,
        title: sourceData.recommendedSteps[1],
        status: 'todo',
        createdAt: new Date('2026-09-10T10:00:00Z'),
        opportunity: { id: opportunityId, impactScore: 7, sourceData },
      },
      {
        id: 'action-2',
        opportunityId,
        title: sourceData.recommendedSteps[0],
        status: 'todo',
        createdAt: new Date('2026-09-10T10:00:01Z'),
        opportunity: { id: opportunityId, impactScore: 7, sourceData },
      },
    ]);

    const result = await service.findAll(organizationId, 'website-1');

    expect(prisma.audit.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId,
        websiteId: 'website-1',
        status: 'completed',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    expect(prisma.actionItem.findMany).toHaveBeenCalledWith({
      where: {
        organizationId,
        opportunity: { auditId: 'audit-latest' },
      },
      include: {
        opportunity: {
          select: { id: true, impactScore: true, sourceData: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(result.map((item) => item.title)).toEqual(
      sourceData.recommendedSteps,
    );
    expect(result.map((item) => item.sequence)).toEqual([1, 2]);
  });

  it('returns an empty list when the selected site has no completed audit', async () => {
    prisma.audit.findFirst.mockResolvedValue(null);

    await expect(service.findAll(organizationId, 'website-1')).resolves.toEqual(
      [],
    );
    expect(prisma.actionItem.findMany).not.toHaveBeenCalled();
  });

  it('scopes PDF data to the latest audit of the selected website', async () => {
    prisma.audit.findFirst.mockResolvedValue({ id: 'audit-latest' });
    prisma.actionItem.findMany.mockResolvedValue([
      {
        id: 'action-1',
        opportunityId,
        title: sourceData.recommendedSteps[0],
        status: 'todo',
        dueDate: null,
        createdAt: new Date(),
        opportunity: { id: opportunityId, impactScore: 7, sourceData },
      },
    ]);

    await expect(
      service.getActionsForExport(organizationId, 'website-1'),
    ).resolves.toEqual([
      {
        title: sourceData.recommendedSteps[0],
        status: 'todo',
        dueDate: null,
      },
    ]);
  });
});
