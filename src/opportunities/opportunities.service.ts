import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  GeneratedOpportunity,
  OpportunityGeneratorService,
} from './opportunity-generator/opportunity-generator.service';
import { N8nWebhookService } from '../integrations/n8n-webhook.service';

@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: OpportunityGeneratorService,
    private readonly webhooks: N8nWebhookService,
  ) {}

  private buildSourceData(opportunity: GeneratedOpportunity) {
    if (!opportunity.rule_code) {
      return opportunity.source_data;
    }

    return {
      version: 2,
      summary: opportunity.source_data,
      ruleCode: opportunity.rule_code,
      severity: opportunity.severity,
      auditStatus: opportunity.audit_status,
      priorityScore: opportunity.priority_score,
      affectedUrls: opportunity.affected_urls ?? [],
      evidence: opportunity.evidence ?? [],
      whyItMatters: opportunity.why_it_matters ?? opportunity.description,
      recommendedSteps: opportunity.recommended_steps ?? [],
    };
  }

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

    const existingOpportunityCount = await this.prisma.opportunity.count({
      where: { auditId: audit.id },
    });

    // La génération est idempotente : les opportunités peuvent déjà avoir des
    // actions, documents et validations liés qu'une régénération détruirait.
    if (existingOpportunityCount > 0) {
      return this.findAllForAudit(organizationId, audit.id);
    }

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
            sourceData: this.buildSourceData(opp),
            status: 'open',
          },
        }),
      ),
    );

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

    const existingOpportunityCount = await this.prisma.opportunity.count({
      where: { auditId: audit.id },
    });

    if (existingOpportunityCount > 0) {
      return this.findAllForAudit(organizationId, audit.id);
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
            sourceData: this.buildSourceData(opp),
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

  async updateStatus(
    organizationId: string,
    opportunityId: string,
    status: 'open' | 'in_progress' | 'done' | 'ignored',
  ) {
    await this.findOne(organizationId, opportunityId);

    return this.prisma.opportunity.update({
      where: { id: opportunityId },
      data: { status },
    });
  }
}
