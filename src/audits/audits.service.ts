import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditRunnerService, SiteAuditResult } from './audit-runner/audit-runner.service';
//import { Prisma } from '@prisma/client';

@Injectable()
export class AuditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditRunner: AuditRunnerService,
  ) {}

  async run(organizationId: string, websiteId: string) {
    const website = await this.prisma.website.findFirst({
      where: { id: websiteId, organizationId },
    });

    if (!website) {
      throw new NotFoundException(
        "Aucun site connecté. Connectez d'abord votre site avant de lancer un audit.",
      );
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { city: true, sector: true, country: true },
    });

    const audit = await this.prisma.audit.create({
      data: {
        organizationId,
        websiteId: website.id,
        status: 'running',
      },
    });

    // Exécution "synchrone" pour le MVP (pas de queue async pour l'instant)
    try {
      const siteResult = await this.auditRunner.runSiteAudit({
        websiteUrl: website.url,
        maxPages: 20,
        maxDepth: 2,
        city: organization?.city,
        country: organization?.country,
      });
      this.ensureSitePages(siteResult);
      await this.persistSitePages(website.id, siteResult);

      const result = await this.auditRunner.runAudit({
        websiteUrl: website.url,
        sector: organization?.sector,
        city: organization?.city,
        country: organization?.country,
      });

      return this.prisma.audit.update({
        where: { id: audit.id },
        data: {
          status: 'completed',
          globalScore: result.global_score,
          // Keep the existing dashboard contract while attaching the
          // multi-page evidence used to generate site-wide opportunities.
          resultJson: { ...result, site_audit: siteResult } as any,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      return this.prisma.audit.update({
        where: { id: audit.id },
        data: {
          status: 'failed',
          errorMessage:
            error instanceof Error ? error.message : 'Erreur inconnue',
        },
      });
    }
  }

  async findLatestForWebsite(organizationId: string, websiteId: string) {
    const audit = await this.prisma.audit.findFirst({
      where: { organizationId, websiteId },
      orderBy: { createdAt: 'desc' },
    });

    if (!audit) {
      throw new NotFoundException('Aucun audit trouvé pour cette organisation');
    }

    return audit;
  }

  async findAllForWebsite(organizationId: string, websiteId: string) {
    return this.prisma.audit.findMany({
      where: { organizationId, websiteId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(organizationId: string, auditId: string) {
    const audit = await this.prisma.audit.findFirst({
      where: { id: auditId, organizationId },
    });

    if (!audit) {
      throw new NotFoundException('Audit non trouvé');
    }

    return audit;
  }

  async runSite(
    organizationId: string,
    websiteId: string,
    maxPages = 20,
    maxDepth = 2,
  ) {
    const website = await this.prisma.website.findFirst({
      where: { id: websiteId, organizationId },
    });

    if (!website) {
      throw new NotFoundException(
        "Aucun site connecté. Connectez d'abord votre site avant de lancer un audit.",
      );
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { city: true, country: true },
    });

    const audit = await this.prisma.audit.create({
      data: {
        organizationId,
        websiteId: website.id,
        status: 'running',
      },
    });

    try {
      const result = await this.auditRunner.runSiteAudit({
        websiteUrl: website.url,
        maxPages,
        maxDepth,
        city: organization?.city,
        country: organization?.country,
      });

      this.ensureSitePages(result);
      await this.persistSitePages(website.id, result);

      return this.prisma.audit.update({
        where: { id: audit.id },
        data: {
          status: 'completed',
          resultJson: result as any,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      return this.prisma.audit.update({
        where: { id: audit.id },
        data: {
          status: 'failed',
          errorMessage:
            error instanceof Error ? error.message : 'Erreur inconnue',
        },
      });
    }
  }

  private ensureSitePages(result: SiteAuditResult) {
    if (
      result.pages_analyzed < 1 ||
      result.pages.length < 1 ||
      !result.pages.some((page) => page.accessible)
    ) {
      throw new Error('Audit multi-pages terminé sans page accessible');
    }
  }

  private async persistSitePages(websiteId: string, result: SiteAuditResult) {
    for (const page of result.pages) {
      await this.prisma.webPage.upsert({
        where: { websiteId_url: { websiteId, url: page.url } },
        create: {
          websiteId,
          url: page.url,
          status: page.accessible ? 'crawled' : 'failed',
          httpStatus: page.status_code,
          title: page.title,
          metaDescription: page.meta_description,
          h1: page.h1,
          h2: page.h2,
          h3: page.h3,
          canonical: page.canonical,
          metaRobots: page.meta_robots,
          wordCount: page.word_count,
          imagesCount: page.images_count,
          imagesWithoutAlt: page.images_without_alt,
          internalLinksCount: page.internal_links_count,
          externalLinksCount: page.external_links_count,
          structuredDataTypes: page.structured_data_types,
          ogTagsPresent: page.og_tags_present,
          topKeywords: page.top_keywords,
          businessAddress: page.business_address,
          businessLatitude: page.business_latitude,
          businessLongitude: page.business_longitude,
          socialLinks: page.social_links,
          jsRenderingUsed: page.js_rendering_used,
          jsRenderingSuspected: page.js_rendering_suspected,
          mainContent: page.main_content,
          errorMessage: page.error,
          crawledAt: page.accessible ? new Date() : null,
        },
        update: {
          status: page.accessible ? 'crawled' : 'failed',
          httpStatus: page.status_code,
          title: page.title,
          metaDescription: page.meta_description,
          h1: page.h1,
          h2: page.h2,
          h3: page.h3,
          canonical: page.canonical,
          metaRobots: page.meta_robots,
          wordCount: page.word_count,
          imagesCount: page.images_count,
          imagesWithoutAlt: page.images_without_alt,
          internalLinksCount: page.internal_links_count,
          externalLinksCount: page.external_links_count,
          structuredDataTypes: page.structured_data_types,
          ogTagsPresent: page.og_tags_present,
          topKeywords: page.top_keywords,
          businessAddress: page.business_address,
          businessLatitude: page.business_latitude,
          businessLongitude: page.business_longitude,
          socialLinks: page.social_links,
          jsRenderingUsed: page.js_rendering_used,
          jsRenderingSuspected: page.js_rendering_suspected,
          mainContent: page.main_content,
          errorMessage: page.error,
          crawledAt: page.accessible ? new Date() : null,
        },
      });
    }

    for (const failedUrl of result.failed_urls) {
      if (result.pages.some((page) => page.url === failedUrl)) {
        continue;
      }
      await this.prisma.webPage.upsert({
        where: { websiteId_url: { websiteId, url: failedUrl } },
        create: { websiteId, url: failedUrl, status: 'failed' },
        update: { status: 'failed' },
      });
    }
  }

}