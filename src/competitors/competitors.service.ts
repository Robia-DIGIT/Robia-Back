import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditRunnerService } from '../audits/audit-runner/audit-runner.service';
import { CreateCompetitorDto } from './dto/create-competitor.dto';

@Injectable()
export class CompetitorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditRunner: AuditRunnerService,
  ) {}

  async create(organizationId: string, dto: CreateCompetitorDto) {
    const website = await this.prisma.website.findFirst({
      where: { id: dto.websiteId, organizationId },
    });

    if (!website) {
      throw new NotFoundException(
        'Aucun site connecté pour cette organisation',
      );
    }

    try {
      return await this.prisma.competitor.create({
        data: {
          organizationId,
          websiteId: dto.websiteId,
          url: dto.url,
          name: dto.name,
          status: 'pending',
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ce concurrent est déjà suivi pour ce site.',
        );
      }
      throw error;
    }
  }

  async findAllForWebsite(organizationId: string, websiteId: string) {
    return this.prisma.competitor.findMany({
      where: { organizationId, websiteId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async remove(organizationId: string, competitorId: string) {
    const competitor = await this.prisma.competitor.findFirst({
      where: { id: competitorId, organizationId },
    });

    if (!competitor) {
      throw new NotFoundException('Concurrent non trouvé');
    }

    await this.prisma.competitor.delete({ where: { id: competitor.id } });
  }

  // Reuses AuditRunnerService directly — the same real audit engine and
  // real scores as AuditsService.run() — rather than going through
  // AuditsService/Audit/Website, so a competitor benchmark can never emit
  // RC-23's audit.completed event, never creates Opportunities, and never
  // writes into web_pages (FK'd to the org's own site).
  async run(organizationId: string, competitorId: string) {
    const competitor = await this.prisma.competitor.findFirst({
      where: { id: competitorId, organizationId },
    });

    if (!competitor) {
      throw new NotFoundException('Concurrent non trouvé');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { city: true, sector: true, country: true },
    });

    await this.prisma.competitor.update({
      where: { id: competitor.id },
      data: { status: 'running', errorMessage: null },
    });

    try {
      const siteResult = await this.auditRunner.runSiteAudit({
        websiteUrl: competitor.url,
        maxPages: 20,
        maxDepth: 2,
        city: organization?.city,
        country: organization?.country,
      });

      if (
        siteResult.pages_analyzed < 1 ||
        siteResult.pages.length < 1 ||
        !siteResult.pages.some((page) => page.accessible)
      ) {
        throw new Error('Audit du concurrent terminé sans page accessible');
      }

      const result = await this.auditRunner.runAudit({
        websiteUrl: competitor.url,
        sector: organization?.sector,
        city: organization?.city,
        country: organization?.country,
      });

      return this.prisma.competitor.update({
        where: { id: competitor.id },
        data: {
          status: 'completed',
          globalScore: result.global_score,
          resultJson: {
            ...result,
            site_audit: siteResult,
          } as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      return this.prisma.competitor.update({
        where: { id: competitor.id },
        data: {
          status: 'failed',
          errorMessage:
            error instanceof Error ? error.message : 'Erreur inconnue',
        },
      });
    }
  }
}
