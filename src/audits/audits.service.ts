import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuditRunnerService,
  SiteAuditResult,
} from './audit-runner/audit-runner.service';
import { GoogleSearchConsoleService } from '../integrations/google-search-console.service';
import { Prisma } from '@prisma/client';
import { AUDIT_COMPLETED_EVENT } from './audit-completed.event';

@Injectable()
export class AuditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditRunner: AuditRunnerService,
    private readonly googleSearchConsole: GoogleSearchConsoleService,
    private readonly logger: PinoLogger,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async run(organizationId: string, websiteId: string, requestId?: string) {
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
    // Every log line for the remainder of this request now carries
    // auditId, alongside requestId/organizationId/userId already bound at
    // the HTTP layer (see logger.config.ts) — the audit is only known
    // once created, so it can't be bound any earlier than this.
    this.logger.assign({ auditId: audit.id });

    // Exécution "synchrone" pour le MVP (pas de queue async pour l'instant)
    try {
      const siteResult = await this.auditRunner.runSiteAudit({
        websiteUrl: website.url,
        maxPages: 20,
        maxDepth: 2,
        city: organization?.city,
        country: organization?.country,
        requestId,
      });
      this.ensureSitePages(siteResult);
      await this.persistSitePages(website.id, siteResult);

      const result = await this.auditRunner.runAudit({
        websiteUrl: website.url,
        sector: organization?.sector,
        city: organization?.city,
        country: organization?.country,
        requestId,
      });

      // RC-13: attaches whatever Search Console signal is already on
      // file, purely as evidence — never influences globalScore, and
      // 'unavailable' (not connected/synced) is a normal, expected value.
      const googleSearchConsole =
        await this.googleSearchConsole.getSearchConsoleSignalsForAudit(
          organizationId,
        );

      const completedAudit = await this.prisma.audit.update({
        where: { id: audit.id },
        data: {
          status: 'completed',
          globalScore: result.global_score,
          // Keep the existing dashboard contract while attaching the
          // multi-page evidence used to generate site-wide opportunities.
          resultJson: {
            ...result,
            site_audit: siteResult,
            google_search_console: googleSearchConsole,
          } as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      // RC-23: in-process, fire-and-forget — never awaited, never able to
      // fail this request. See audit-completed.event.ts for why this is an
      // event rather than a direct call into OpsAutomationModule.
      this.eventEmitter.emit(AUDIT_COMPLETED_EVENT, {
        organizationId,
        auditId: completedAudit.id,
        websiteId: website.id,
        globalScore: completedAudit.globalScore,
      });
      return completedAudit;
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
    this.logger.assign({ auditId });

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
    requestId?: string,
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
    this.logger.assign({ auditId: audit.id });

    try {
      const result = await this.auditRunner.runSiteAudit({
        websiteUrl: website.url,
        maxPages,
        maxDepth,
        city: organization?.city,
        country: organization?.country,
        requestId,
      });

      this.ensureSitePages(result);
      await this.persistSitePages(website.id, result);

      const googleSearchConsole =
        await this.googleSearchConsole.getSearchConsoleSignalsForAudit(
          organizationId,
        );

      const completedAudit = await this.prisma.audit.update({
        where: { id: audit.id },
        data: {
          status: 'completed',
          resultJson: {
            ...result,
            google_search_console: googleSearchConsole,
          } as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      // RC-23 — see run() above for why this is a fire-and-forget event.
      // globalScore stays null here: runSite() never computes one, and
      // this event never fabricates a value the audit itself doesn't have.
      this.eventEmitter.emit(AUDIT_COMPLETED_EVENT, {
        organizationId,
        auditId: completedAudit.id,
        websiteId: website.id,
        globalScore: completedAudit.globalScore,
      });
      return completedAudit;
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
