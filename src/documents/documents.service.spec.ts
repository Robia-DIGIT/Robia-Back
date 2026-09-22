import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DocumentGeneratorService } from './document-generator/document-generator.service';
import { DocumentsService } from './documents.service';
import { PrismaService } from '../prisma/prisma.service';

function contextPrisma() {
  const prisma = {
    opportunity: { findFirst: jest.fn() },
    website: { findFirst: jest.fn() },
    actionItem: { findFirst: jest.fn(), updateMany: jest.fn() },
    document: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (callback: (tx: typeof prisma) => unknown) => callback(prisma),
  );
  return prisma;
}

const website = {
  id: 'website-a',
  url: 'https://example.mg',
  organization: {
    name: 'Entreprise A',
    sector: 'Services',
    city: 'Antananarivo',
    country: 'MG',
  },
};

describe('DocumentsService Content Studio', () => {
  it('generates freely for a tenant-scoped website and sends the real brief', async () => {
    const prisma = contextPrisma();
    prisma.website.findFirst.mockResolvedValue(website);
    prisma.document.create.mockResolvedValue({ id: 'document-a', revision: 1 });
    const generator = {
      generate: jest.fn().mockResolvedValue({
        title: 'Conseils locaux',
        content: 'Contenu utile',
      }),
    };
    const service = new DocumentsService(
      prisma as unknown as PrismaService,
      generator as unknown as DocumentGeneratorService,
    );

    await service.generate('org-a', {
      websiteId: 'website-a',
      type: 'local_page',
      brief: {
        objective: 'Présenter le service local',
        audience: 'PME malgaches',
        tone: 'Direct',
        facts: ['Disponible sur rendez-vous'],
      },
    });

    expect(prisma.website.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'website-a', organizationId: 'org-a' },
      }),
    );
    expect(generator.generate).toHaveBeenCalledWith(
      'local_page',
      'Présenter le service local',
      'Présenter le service local',
      expect.objectContaining({
        organizationName: 'Entreprise A',
        websiteUrl: 'https://example.mg',
        audience: 'PME malgaches',
        userProvidedFacts: ['Disponible sur rendez-vous'],
      }),
    );
    expect(prisma.document.create).toHaveBeenCalledWith({
      // Jest asymmetric matchers are typed as any in this repository's version.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        organizationId: 'org-a',
        websiteId: 'website-a',
        opportunityId: null,
      }),
    });
  });

  it('derives the website from an opportunity and refuses a mismatch', async () => {
    const prisma = contextPrisma();
    prisma.opportunity.findFirst.mockResolvedValue({
      id: 'opportunity-a',
      title: 'Optimiser la page',
      description: 'Description',
      audit: { websiteId: 'website-a' },
    });
    const service = new DocumentsService(
      prisma as unknown as PrismaService,
      { generate: jest.fn() } as unknown as DocumentGeneratorService,
    );

    await expect(
      service.generate('org-a', {
        opportunityId: 'opportunity-a',
        websiteId: 'website-b',
        type: 'meta',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.website.findFirst).not.toHaveBeenCalled();
  });

  it('accepts an opportunity brief without an explicit objective', async () => {
    const prisma = contextPrisma();
    prisma.opportunity.findFirst.mockResolvedValue({
      id: 'opportunity-a',
      title: 'Optimiser la page locale',
      description: 'Description',
      audit: { websiteId: 'website-a' },
    });
    prisma.website.findFirst.mockResolvedValue(website);
    prisma.document.create.mockResolvedValue({ id: 'document-a', revision: 1 });
    const generator = {
      generate: jest.fn().mockResolvedValue({
        title: 'Titre',
        content: 'Contenu',
      }),
    };
    const service = new DocumentsService(
      prisma as unknown as PrismaService,
      generator as unknown as DocumentGeneratorService,
    );

    await service.generate('org-a', {
      opportunityId: 'opportunity-a',
      type: 'local_page',
      brief: { audience: 'Clients locaux' },
    });

    expect(generator.generate).toHaveBeenCalledWith(
      'local_page',
      'Optimiser la page locale',
      'Description',
      expect.objectContaining({
        objective: 'Optimiser la page locale',
        audience: 'Clients locaux',
      }),
    );
  });

  it('links a document only to a compatible, unclaimed action', async () => {
    const prisma = contextPrisma();
    prisma.website.findFirst.mockResolvedValue(website);
    prisma.actionItem.findFirst.mockResolvedValue({
      id: 'action-a',
      opportunityId: null,
    });
    prisma.document.create.mockResolvedValue({ id: 'document-a' });
    prisma.actionItem.updateMany.mockResolvedValue({ count: 0 });
    const service = new DocumentsService(
      prisma as unknown as PrismaService,
      {
        generate: jest
          .fn()
          .mockResolvedValue({ title: 'Titre', content: 'Texte' }),
      } as unknown as DocumentGeneratorService,
    );

    await expect(
      service.generate('org-a', {
        websiteId: 'website-a',
        actionItemId: 'action-a',
        type: 'gbp_post',
        brief: { objective: 'Informer les clients' },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lists a bounded website library within the organization', async () => {
    const prisma = contextPrisma();
    prisma.document.findMany.mockResolvedValue([]);
    const service = new DocumentsService(
      prisma as unknown as PrismaService,
      {} as DocumentGeneratorService,
    );

    await service.findAll('org-a', { websiteId: 'website-a' });

    expect(prisma.document.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', websiteId: 'website-a' },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
  });

  it('rejects a stale edit with an atomic revision check', async () => {
    const prisma = contextPrisma();
    prisma.document.updateMany.mockResolvedValue({ count: 0 });
    prisma.document.findFirst.mockResolvedValue({ id: 'document-a' });
    const service = new DocumentsService(
      prisma as unknown as PrismaService,
      {} as DocumentGeneratorService,
    );

    await expect(
      service.update('org-a', 'document-a', {
        expectedRevision: 2,
        content: 'Nouvelle version',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.document.updateMany).toHaveBeenCalledWith({
      where: { id: 'document-a', organizationId: 'org-a', revision: 2 },
      data: {
        content: 'Nouvelle version',
        status: 'edited',
        revision: { increment: 1 },
      },
    });
  });

  it('keeps the pre-RC39 editor compatible when expectedRevision is absent', async () => {
    const prisma = contextPrisma();
    prisma.document.findFirst
      .mockResolvedValueOnce({ id: 'document-a', revision: 4 })
      .mockResolvedValueOnce({ id: 'document-a', revision: 5 });
    prisma.document.updateMany.mockResolvedValue({ count: 1 });
    const service = new DocumentsService(
      prisma as unknown as PrismaService,
      {} as DocumentGeneratorService,
    );

    await service.update('org-a', 'document-a', {
      content: 'Texte historique',
    });

    expect(prisma.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'document-a',
          organizationId: 'org-a',
          revision: 4,
        },
      }),
    );
  });

  it('returns not found rather than conflict for another tenant document', async () => {
    const prisma = contextPrisma();
    prisma.document.updateMany.mockResolvedValue({ count: 0 });
    prisma.document.findFirst.mockResolvedValue(null);
    const service = new DocumentsService(
      prisma as unknown as PrismaService,
      {} as DocumentGeneratorService,
    );

    await expect(
      service.update('org-a', 'document-b', {
        expectedRevision: 1,
        content: 'Texte',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
