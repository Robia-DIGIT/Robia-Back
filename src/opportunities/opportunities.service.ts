import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpportunityGeneratorService } from './opportunity-generator/opportunity-generator.service';
import { N8nWebhookService } from '../integrations/n8n-webhook.service';

@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: OpportunityGeneratorService,
    private readonly webhooks: N8nWebhookService,
  ) {}

  async generateFromAudit(organizationId: string, auditId: string) {
    const audit = await this.prisma.audit.findFirst({
      where: { id: auditId, organizationId, status: 'completed' },
      include: {
        website: { select: { url: true } },
        organization: {
          select: { owner: { select: { name: true, email: true } } },
        },
      },
    });

    if (!audit) {
      throw new NotFoundException(
        "Aucun audit non trouvé ou non terminé. Vérifiez l'auditId fourni.",
      );
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { city: true, country: true },
    });

    const auditResult = audit.resultJson as Record<string, any>;
    const siteAuditResult = auditResult?.site_audit;
    const hasSiteEvidence =
      siteAuditResult &&
      typeof siteAuditResult === 'object' &&
      Number(siteAuditResult.pages_analyzed) > 0 &&
      Array.isArray(siteAuditResult.pages);

    const generated = hasSiteEvidence
      ? await this.generator.generateForSite({
          siteAuditResult,
          city: organization?.city,
          country: organization?.country,
        })
      : await this.generator.generate(auditResult, organization?.city);

    const existingOpportunityCount = await this.prisma.opportunity.count({
      where: { auditId: audit.id },
    });

    // On supprime les anciennes opportunités liées à cet audit avant d'en générer de nouvelles
    // (évite l'accumulation si on relance la génération plusieurs fois sur le même audit)
    await this.prisma.opportunity.deleteMany({
      where: { auditId: audit.id },
    });

    const opportunities = await this.prisma.$transaction(
      generated.map((opp) =>
        this.prisma.opportunity.create({
          data: {
            organizationId,
            auditId: audit.id,
            title: opp.title,
            description: opp.description,
            category: opp.category,
            impactScore: opp.impact_score,
            effortScore: opp.effort_score,
            confidenceScore: opp.confidence_score,
            sourceData: opp.source_data,
            status: 'open',
          },
        }),
      ),
    );

    if (existingOpportunityCount === 0) {
      const scoreCandidate = audit.globalScore ?? auditResult?.global_score;
      const score = Number(scoreCandidate);
      void this.webhooks
        .notifyAuditCompleted({
          auditId: audit.id,
          email: audit.organization.owner.email,
          userName: audit.organization.owner.name,
          websiteUrl: audit.website.url,
          score: Number.isFinite(score) ? score : null,
          opportunities: opportunities.map((opportunity) => opportunity.title),
          completedAt: audit.completedAt ?? new Date(),
        })
        .catch(() => undefined);
    }

    return opportunities;
  }

  async generateFromSiteAudit(organizationId: string, auditId: string) {
    const audit = await this.prisma.audit.findFirst({
      where: { id: auditId, organizationId, status: 'completed' },
    });

    if (!audit) {
      throw new NotFoundException(
        "Aucun audit non trouvé ou non terminé. Vérifiez l'auditId fourni.",
      );
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { city: true, country: true },
    });

    const generated = await this.generator.generateForSite({
      siteAuditResult: audit.resultJson as Record<string, any>,
      city: organization?.city,
      country: organization?.country,
    });

    // Même logique de remplacement que generateFromAudit() : on évite
    // l'accumulation si la génération est relancée sur le même audit.
    await this.prisma.opportunity.deleteMany({
      where: { auditId: audit.id },
    });

    return this.prisma.$transaction(
      generated.map((opp) =>
        this.prisma.opportunity.create({
          data: {
            organizationId,
            auditId: audit.id,
            title: opp.title,
            description: opp.description,
            category: opp.category,
            impactScore: opp.impact_score,
            effortScore: opp.effort_score,
            confidenceScore: opp.confidence_score,
            sourceData: opp.source_data,
            status: 'open',
          },
        }),
      ),
    );
  }

  async findAllForAudit(organizationId: string, auditId: string) {
    return this.prisma.opportunity.findMany({
      where: { organizationId, auditId },
      orderBy: { impactScore: 'desc' },
      take: 5,
    });
  }

  async findOne(organizationId: string, opportunityId: string) {
    const opportunity = await this.prisma.opportunity.findFirst({
      where: { id: opportunityId, organizationId },
    });

    if (!opportunity) {
      throw new NotFoundException('Opportunité non trouvée');
    }

    return opportunity;
  }
}
