import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CompetitorsService } from './competitors.service';
import { AuditRunnerService } from '../audits/audit-runner/audit-runner.service';

describe('CompetitorsService', () => {
  const organizationId = 'org-1';
  const websiteId = 'website-1';
  const competitorId = 'competitor-1';

  let prisma: any;
  let auditRunner: { runSiteAudit: jest.Mock; runAudit: jest.Mock };
  let service: CompetitorsService;

  const page = {
    url: 'https://concurrent.example.com',
    accessible: true,
  };

  const siteResult = {
    base_url: 'https://concurrent.example.com',
    pages_discovered: 1,
    pages_analyzed: 1,
    pages: [page],
    failed_urls: [],
  };

  const auditResult = {
    global_score: 71,
    subscores: {
      local: 60,
      technical: 80,
      content: 75,
      performance: 70,
      ai_readiness: 50,
    },
    missing_data: [],
    summary: 'Résumé concurrent',
  };

  beforeEach(() => {
    prisma = {
      website: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: websiteId, organizationId }),
      },
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          city: 'Antananarivo',
          sector: 'SaaS',
          country: 'Madagascar',
        }),
      },
      competitor: {
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: competitorId, ...data }),
          ),
        findFirst: jest.fn().mockResolvedValue({
          id: competitorId,
          organizationId,
          websiteId,
          url: 'https://concurrent.example.com',
        }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: competitorId, ...data }),
          ),
        delete: jest.fn().mockResolvedValue({ id: competitorId }),
      },
    };
    auditRunner = {
      runSiteAudit: jest.fn().mockResolvedValue(siteResult),
      runAudit: jest.fn().mockResolvedValue(auditResult),
    };
    service = new CompetitorsService(
      prisma,
      auditRunner as unknown as AuditRunnerService,
    );
  });

  describe('create', () => {
    it('creates a competitor scoped to the organization’s own website', async () => {
      const result = await service.create(organizationId, {
        websiteId,
        url: 'https://concurrent.example.com',
        name: 'Concurrent A',
      });

      expect(prisma.website.findFirst).toHaveBeenCalledWith({
        where: { id: websiteId, organizationId },
      });
      expect(prisma.competitor.create).toHaveBeenCalledWith({
        data: {
          organizationId,
          websiteId,
          url: 'https://concurrent.example.com',
          name: 'Concurrent A',
          status: 'pending',
        },
      });
      expect(result.status).toBe('pending');
    });

    it('never creates a competitor under a website belonging to another organization', async () => {
      prisma.website.findFirst.mockResolvedValue(null);

      await expect(
        service.create(organizationId, {
          websiteId,
          url: 'https://concurrent.example.com',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.competitor.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate competitor URL for the same website', async () => {
      prisma.competitor.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: '7.8.0',
        }),
      );

      await expect(
        service.create(organizationId, {
          websiteId,
          url: 'https://concurrent.example.com',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findAllForWebsite', () => {
    it('only queries competitors scoped to this organization and website', async () => {
      await service.findAllForWebsite(organizationId, websiteId);

      expect(prisma.competitor.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId, websiteId } }),
      );
    });
  });

  describe('remove', () => {
    it('deletes a competitor scoped to the organization', async () => {
      const result = await service.remove(organizationId, competitorId);

      expect(prisma.competitor.findFirst).toHaveBeenCalledWith({
        where: { id: competitorId, organizationId },
      });
      expect(prisma.competitor.delete).toHaveBeenCalledWith({
        where: { id: competitorId },
      });
      expect(result).toEqual({ deleted: true });
    });

    it('never deletes a competitor belonging to another organization', async () => {
      prisma.competitor.findFirst.mockResolvedValue(null);

      await expect(
        service.remove(organizationId, competitorId),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.competitor.delete).not.toHaveBeenCalled();
    });
  });

  describe('run', () => {
    it('completes with the real score/subscores from the audit engine — never fabricated', async () => {
      const result = await service.run(organizationId, competitorId);

      expect(auditRunner.runSiteAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          websiteUrl: 'https://concurrent.example.com',
        }),
      );
      expect(auditRunner.runAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          websiteUrl: 'https://concurrent.example.com',
        }),
      );
      expect(prisma.competitor.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: competitorId },
          data: expect.objectContaining({ status: 'running' }),
        }),
      );
      expect(result.status).toBe('completed');
      expect(result.globalScore).toBe(71);
      expect(result.resultJson).toEqual(
        expect.objectContaining({ global_score: 71, site_audit: siteResult }),
      );
    });

    it('marks the competitor failed instead of completing with zero accessible pages', async () => {
      auditRunner.runSiteAudit.mockResolvedValue({
        ...siteResult,
        pages_analyzed: 0,
        pages: [],
      });

      const result = await service.run(organizationId, competitorId);

      expect(auditRunner.runAudit).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.errorMessage).toBe(
        'Audit du concurrent terminé sans page accessible',
      );
    });

    it('marks the competitor failed when the audit engine itself fails', async () => {
      auditRunner.runAudit.mockRejectedValue(new Error('AI engine down'));

      const result = await service.run(organizationId, competitorId);

      expect(result.status).toBe('failed');
      expect(result.errorMessage).toBe('AI engine down');
    });

    it('never runs a competitor belonging to another organization', async () => {
      prisma.competitor.findFirst.mockResolvedValue(null);

      await expect(service.run(organizationId, competitorId)).rejects.toThrow(
        NotFoundException,
      );
      expect(auditRunner.runSiteAudit).not.toHaveBeenCalled();
    });
  });
});
