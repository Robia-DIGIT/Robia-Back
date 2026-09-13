import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActionGeneratorService } from './action-items/action-generator/action-generator.service';
import { ActionItemsService } from './action-items/action-items.service';
import { AuditRunnerService } from './audits/audit-runner/audit-runner.service';
import { AuditsService } from './audits/audits.service';
import { DocumentGeneratorService } from './documents/document-generator/document-generator.service';
import { DocumentsService } from './documents/documents.service';
import { GenerateDocumentDto } from './documents/dto/generate-document.dto';
import { GoogleSearchConsoleService } from './integrations/google-search-console.service';
import { N8nWebhookService } from './integrations/n8n-webhook.service';
import { LocationPlacesService } from './locations/location-places/location-places.service';
import { LocationWeatherService } from './locations/location-weather/location-weather.service';
import { LocationsService } from './locations/locations.service';
import { OpportunityGeneratorService } from './opportunities/opportunity-generator/opportunity-generator.service';
import { OpportunitiesService } from './opportunities/opportunities.service';
import { PrismaService } from './prisma/prisma.service';
import { WebsitesService } from './websites/websites.service';

/**
 * RC-16 — multi-tenant isolation, generalized (Codex review). Complements
 * organization-isolation.spec.ts (which already covers the OrgScopeGuard
 * itself, plus one read/write example per surface) with the full set of
 * sensitive surfaces named in that review: websites, audits, opportunities,
 * action items, documents, locations, and organization-scoped Google
 * integrations.
 *
 * Every test proves the same shape of thing: organization A's id is passed
 * to a service method addressing a resource that only exists (in the mocked
 * Prisma layer) under organization B — and the call must fail exactly as if
 * the resource didn't exist at all, never partially succeed, never leak B's
 * data to A, and never let A mutate/launch an operation against it. No real
 * network or database calls anywhere in this file — Prisma is mocked.
 */
describe('Multi-tenant isolation (RC-16)', () => {
  const orgA = 'org-a';
  const orgB = 'org-b';

  describe('Websites', () => {
    it("does not list another organization's websites", async () => {
      const prisma = { website: { findMany: jest.fn().mockResolvedValue([]) } };
      const service = new WebsitesService(prisma as unknown as PrismaService);

      const result = await service.findAll(orgA);

      expect(result).toEqual([]);
      expect(prisma.website.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: orgA, status: { not: 'archived' } },
        }),
      );
    });

    it('does not change the status of a website owned by another organization', async () => {
      const prisma = {
        website: {
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
        },
      };
      const service = new WebsitesService(prisma as unknown as PrismaService);

      await expect(
        service.updateStatus(orgA, 'website-org-b', 'valid'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.website.findFirst).toHaveBeenCalledWith({
        where: { id: 'website-org-b', organizationId: orgA },
      });
      expect(prisma.website.update).not.toHaveBeenCalled();
    });

    it('does not archive a website owned by another organization', async () => {
      const prisma = {
        website: {
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
        },
      };
      const service = new WebsitesService(prisma as unknown as PrismaService);

      await expect(
        service.archive(orgA, 'website-org-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.website.update).not.toHaveBeenCalled();
    });
  });

  describe('Audits', () => {
    it('does not return an audit owned by another organization', async () => {
      const prisma = {
        audit: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const runner = { runSiteAudit: jest.fn(), runAudit: jest.fn() };
      const googleSearchConsole = {
        getSearchConsoleSignalsForAudit: jest.fn(),
      };
      const service = new AuditsService(
        prisma as unknown as PrismaService,
        runner as unknown as AuditRunnerService,
        googleSearchConsole as unknown as GoogleSearchConsoleService,
      );

      await expect(service.findOne(orgA, 'audit-org-b')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.audit.findFirst).toHaveBeenCalledWith({
        where: { id: 'audit-org-b', organizationId: orgA },
      });
      expect(
        googleSearchConsole.getSearchConsoleSignalsForAudit,
      ).not.toHaveBeenCalled();
    });

    it('does not list audits for a website owned by another organization', async () => {
      const prisma = { audit: { findMany: jest.fn().mockResolvedValue([]) } };
      const runner = { runSiteAudit: jest.fn(), runAudit: jest.fn() };
      const googleSearchConsole = {
        getSearchConsoleSignalsForAudit: jest.fn(),
      };
      const service = new AuditsService(
        prisma as unknown as PrismaService,
        runner as unknown as AuditRunnerService,
        googleSearchConsole as unknown as GoogleSearchConsoleService,
      );

      const result = await service.findAllForWebsite(orgA, 'website-org-b');

      expect(result).toEqual([]);
      expect(prisma.audit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: orgA, websiteId: 'website-org-b' },
        }),
      );
      expect(
        googleSearchConsole.getSearchConsoleSignalsForAudit,
      ).not.toHaveBeenCalled();
    });

    it('does not launch a multi-page audit (runSite) for a website owned by another organization', async () => {
      const prisma = {
        website: { findFirst: jest.fn().mockResolvedValue(null) },
        audit: { create: jest.fn() },
      };
      const runner = { runSiteAudit: jest.fn(), runAudit: jest.fn() };
      const googleSearchConsole = {
        getSearchConsoleSignalsForAudit: jest.fn(),
      };
      const service = new AuditsService(
        prisma as unknown as PrismaService,
        runner as unknown as AuditRunnerService,
        googleSearchConsole as unknown as GoogleSearchConsoleService,
      );

      await expect(
        service.runSite(orgA, 'website-org-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.audit.create).not.toHaveBeenCalled();
      expect(runner.runSiteAudit).not.toHaveBeenCalled();
      expect(
        googleSearchConsole.getSearchConsoleSignalsForAudit,
      ).not.toHaveBeenCalled();
    });
  });

  describe('Opportunities', () => {
    it('does not list opportunities for an audit owned by another organization', async () => {
      const prisma = {
        opportunity: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const service = new OpportunitiesService(
        prisma as unknown as PrismaService,
        {} as unknown as OpportunityGeneratorService,
        {} as unknown as N8nWebhookService,
      );

      const result = await service.findAllForAudit(orgA, 'audit-org-b');

      expect(result).toEqual([]);
      expect(prisma.opportunity.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: orgA, auditId: 'audit-org-b' },
        }),
      );
    });

    it('does not generate opportunities from an audit owned by another organization', async () => {
      const prisma = {
        audit: { findFirst: jest.fn().mockResolvedValue(null) },
        opportunity: { count: jest.fn(), create: jest.fn() },
      };
      const generator = { generate: jest.fn(), generateForSite: jest.fn() };
      const service = new OpportunitiesService(
        prisma as unknown as PrismaService,
        generator as unknown as OpportunityGeneratorService,
        {} as unknown as N8nWebhookService,
      );

      await expect(
        service.generateFromAudit(orgA, 'audit-org-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.opportunity.count).not.toHaveBeenCalled();
      expect(generator.generate).not.toHaveBeenCalled();
      expect(generator.generateForSite).not.toHaveBeenCalled();
    });

    it('does not change the status of an opportunity owned by another organization', async () => {
      const prisma = {
        opportunity: {
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
        },
      };
      const service = new OpportunitiesService(
        prisma as unknown as PrismaService,
        {} as unknown as OpportunityGeneratorService,
        {} as unknown as N8nWebhookService,
      );

      await expect(
        service.updateStatus(orgA, 'opportunity-org-b', 'done'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.opportunity.update).not.toHaveBeenCalled();
    });
  });

  describe('Action items', () => {
    it("does not list action items scoped to another organization's website", async () => {
      const prisma = {
        audit: { findFirst: jest.fn().mockResolvedValue(null) },
        actionItem: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const service = new ActionItemsService(
        prisma as unknown as PrismaService,
        {} as unknown as ActionGeneratorService,
      );

      const result = await service.findAll(orgA, 'website-org-b');

      // No completed audit for org A on org B's website -> empty, and the
      // actionItem table is never even queried with org B's data in scope.
      expect(result).toEqual([]);
      expect(prisma.actionItem.findMany).not.toHaveBeenCalled();
    });

    it('does not generate actions from an opportunity owned by another organization', async () => {
      const prisma = {
        opportunity: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const generator = { generateFromOpportunity: jest.fn() };
      const service = new ActionItemsService(
        prisma as unknown as PrismaService,
        generator as unknown as ActionGeneratorService,
      );

      await expect(
        service.generateFromOpportunity(orgA, 'opportunity-org-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(generator.generateFromOpportunity).not.toHaveBeenCalled();
    });

    it('does not change the due date of an action owned by another organization', async () => {
      const prisma = {
        actionItem: {
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
        },
      };
      const service = new ActionItemsService(
        prisma as unknown as PrismaService,
        {} as unknown as ActionGeneratorService,
      );

      await expect(
        service.updateDueDate(orgA, 'action-org-b', new Date('2026-01-01')),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.actionItem.update).not.toHaveBeenCalled();
    });

    it('only ever schedules actions belonging to the requesting organization', async () => {
      const prisma = {
        actionItem: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const service = new ActionItemsService(
        prisma as unknown as PrismaService,
        {} as unknown as ActionGeneratorService,
      );

      const result = await service.generatePlan(orgA);

      expect(result).toEqual([]);
      expect(prisma.actionItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: orgA, status: 'todo', dueDate: null },
        }),
      );
    });
  });

  describe('Documents', () => {
    it('does not return a document owned by another organization', async () => {
      const prisma = {
        document: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const service = new DocumentsService(
        prisma as unknown as PrismaService,
        {} as unknown as DocumentGeneratorService,
      );

      await expect(
        service.findOne(orgA, 'document-org-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.document.findFirst).toHaveBeenCalledWith({
        where: { id: 'document-org-b', organizationId: orgA },
      });
    });

    it('does not list documents for an opportunity owned by another organization', async () => {
      const prisma = {
        document: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const service = new DocumentsService(
        prisma as unknown as PrismaService,
        {} as unknown as DocumentGeneratorService,
      );

      const result = await service.findAllByOpportunity(
        orgA,
        'opportunity-org-b',
      );

      expect(result).toEqual([]);
      expect(prisma.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: orgA, opportunityId: 'opportunity-org-b' },
        }),
      );
    });

    it('does not generate a document from an opportunity owned by another organization', async () => {
      const prisma = {
        opportunity: { findFirst: jest.fn().mockResolvedValue(null) },
        document: { create: jest.fn() },
      };
      const generator = { generate: jest.fn() };
      const service = new DocumentsService(
        prisma as unknown as PrismaService,
        generator as unknown as DocumentGeneratorService,
      );

      await expect(
        service.generate(orgA, {
          opportunityId: 'opportunity-org-b',
          type: 'blog_post',
        } as unknown as GenerateDocumentDto),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(generator.generate).not.toHaveBeenCalled();
      expect(prisma.document.create).not.toHaveBeenCalled();
    });
  });

  describe('Locations', () => {
    it('does not return a location owned by another organization', async () => {
      const prisma = {
        location: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const service = new LocationsService(
        prisma as unknown as PrismaService,
        {} as unknown as LocationPlacesService,
        {} as unknown as LocationWeatherService,
      );

      await expect(
        service.findOne(orgA, 'location-org-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.location.findFirst).toHaveBeenCalledWith({
        where: { id: 'location-org-b', organizationId: orgA },
      });
    });

    it("does not list another organization's locations", async () => {
      const prisma = {
        location: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const service = new LocationsService(
        prisma as unknown as PrismaService,
        {} as unknown as LocationPlacesService,
        {} as unknown as LocationWeatherService,
      );

      const result = await service.findAll(orgA);

      expect(result).toEqual([]);
      expect(prisma.location.findMany).toHaveBeenCalledWith({
        where: { organizationId: orgA },
      });
    });

    it('does not fetch weather for a location owned by another organization', async () => {
      const prisma = {
        location: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const weather = { getCurrentWeather: jest.fn() };
      const service = new LocationsService(
        prisma as unknown as PrismaService,
        {} as unknown as LocationPlacesService,
        weather,
      );

      await expect(
        service.getWeather(orgA, 'location-org-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(weather.getCurrentWeather).not.toHaveBeenCalled();
    });
  });

  describe('Google integrations (organization-scoped)', () => {
    // GoogleSearchConsoleConnection has a *unique* organizationId column
    // (see prisma/schema.prisma) rather than the id+organizationId
    // double-filter used elsewhere — so the isolation guarantee here is
    // that every lookup is keyed by the caller's own organizationId, never
    // by a client-suppliable id that could point at another row. These
    // tests prove that org A querying its own (unconnected) status never
    // surfaces org B's connection, even when org B's row exists in the
    // same mocked table.
    function connectionRowFor(organizationId: string) {
      return organizationId === orgB
        ? {
            googleAccountEmail: 'owner@org-b.example',
            selectedSiteUrl: 'sc-domain:org-b.example',
            permissionLevel: 'siteOwner',
            connectedAt: new Date('2026-01-01'),
            lastSyncedAt: new Date('2026-01-02'),
            lastAnalyticsSyncedAt: null,
            selectedAnalyticsPropertyId: null,
            selectedAnalyticsPropertyName: null,
            grantedScopes:
              'https://www.googleapis.com/auth/webmasters.readonly',
          }
        : null;
    }

    it('reports "not connected" for an organization with no connection, even though another organization has one', async () => {
      const prisma = {
        googleSearchConsoleConnection: {
          findUnique: jest.fn(
            ({
              where: { organizationId },
            }: {
              where: { organizationId: string };
            }) => Promise.resolve(connectionRowFor(organizationId)),
          ),
        },
      };
      const config = { get: jest.fn() };
      const service = new GoogleSearchConsoleService(
        prisma as unknown as PrismaService,
        config as unknown as ConfigService,
      );

      const status = await service.getStatus(orgA);

      expect(status.connected).toBe(false);
      expect(status.googleAccountEmail).toBeNull();
      expect(
        prisma.googleSearchConsoleConnection.findUnique,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: orgA } }),
      );
    });

    it("only ever disconnects the caller's own organization, never another one", async () => {
      const prisma = {
        googleSearchConsoleConnection: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      };
      const config = { get: jest.fn() };
      const service = new GoogleSearchConsoleService(
        prisma as unknown as PrismaService,
        config as unknown as ConfigService,
      );

      await service.disconnect(orgA);

      expect(
        prisma.googleSearchConsoleConnection.deleteMany,
      ).toHaveBeenCalledWith({
        where: { organizationId: orgA },
      });
      expect(
        prisma.googleSearchConsoleConnection.deleteMany,
      ).not.toHaveBeenCalledWith({
        where: { organizationId: orgB },
      });
    });
  });
});
