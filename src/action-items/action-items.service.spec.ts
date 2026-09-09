import { ActionItemsService } from './action-items.service';

describe('ActionItemsService', () => {
  const organizationId = 'org-1';
  const opportunityId = 'opp-1';
  let prisma: any;
  let generator: any;
  let service: ActionItemsService;

  beforeEach(() => {
    prisma = {
      opportunity: { findFirst: jest.fn() },
      actionItem: {
        findMany: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn((operations) => Promise.all(operations)),
    };
    generator = { generateFromOpportunity: jest.fn() };
    service = new ActionItemsService(prisma, generator);
  });

  it('returns existing actions instead of creating duplicates', async () => {
    const existing = [{ id: 'action-1', opportunityId, title: 'Action' }];
    prisma.opportunity.findFirst.mockResolvedValue({
      id: opportunityId,
      title: 'Opportunity',
      description: 'Description',
    });
    prisma.actionItem.findMany.mockResolvedValue(existing);

    await expect(
      service.generateFromOpportunity(organizationId, opportunityId),
    ).resolves.toEqual(existing);
    expect(generator.generateFromOpportunity).not.toHaveBeenCalled();
    expect(prisma.actionItem.create).not.toHaveBeenCalled();
  });

  it('scopes action lists and PDF data to the selected website', async () => {
    prisma.actionItem.findMany.mockResolvedValue([]);

    await service.findAll(organizationId, 'website-1');
    expect(prisma.actionItem.findMany).toHaveBeenLastCalledWith({
      where: {
        organizationId,
        opportunity: { audit: { websiteId: 'website-1' } },
      },
      orderBy: { createdAt: 'desc' },
    });

    await service.getActionsForExport(organizationId, 'website-1');
    expect(prisma.actionItem.findMany).toHaveBeenLastCalledWith({
      where: {
        organizationId,
        opportunity: { audit: { websiteId: 'website-1' } },
      },
      orderBy: { createdAt: 'desc' },
      select: { title: true, status: true, dueDate: true },
    });
  });
});
