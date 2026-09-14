import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  GeneratedOpportunity,
  OpportunityGeneratorService,
} from './opportunity-generator/opportunity-generator.service';
import { N8nWebhookService } from '../integrations/n8n-webhook.service';
import { SiteAuditResult } from '../audits/audit-runner/audit-runner.service';
import { MetaService } from '../integrations/meta.service';
import {
  evaluateMetaFindings,
  MetaFinding,
} from '../integrations/meta-insights';
import { Prisma } from '@prisma/client';

// audit.resultJson is untrusted, raw persisted JSON (see AuditsService) — this
// only asserts the shape RC-10's evidence-based pipeline actually writes into
// site_audit; the runtime checks below still guard against anything else
// having landed there historically.
function hasSitePages(
  value: SiteAuditResult | undefined,
): value is SiteAuditResult {
  return (
    !!value && Number(value.pages_analyzed) > 0 && Array.isArray(value.pages)
  );
}

@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: OpportunityGeneratorService,
    private readonly webhooks: N8nWebhookService,
    private readonly meta: MetaService,
  ) {}

  // RC-19: source_data shape for a Meta-originated opportunity. Deliberately
  // separate from buildSourceData()'s SEO-oriented shape (rule_code/severity/
  // priority_score/affected_urls) rather than overloading it — Meta findings
  // have a different evidence model and must always self-identify as
  // `source: 'meta'` / `scoreInfluence: false` so nothing downstream can
  // mistake them for score-influencing SEO findings.
  private buildMetaSourceData(finding: MetaFinding) {
    return {
      version: 1,
      source: finding.source,
      ruleCode: finding.ruleCode,
      confidence: finding.confidence,
      evidence: finding.evidence,
      recommendation: finding.recommendation,
      scoreInfluence: finding.scoreInfluence,
    } as unknown as Prisma.InputJsonValue;
  }

  // RC-19: MetaService.getInsightSignals() never throws (mirrors
  // GoogleSearchConsoleService's RC-13 guarantee) and evaluateMetaFindings()
  // is a pure, exception-free function — so, like AuditsService's GSC
  // attachment, this call is intentionally not wrapped in an extra
  // try/catch here: opportunity generation must never fail because a Meta
  // side-signal read hiccuped.
  private async generateMetaOpportunities(
    organizationId: string,
    auditId: string,
  ) {
    const signals = await this.meta.getInsightSignals(organizationId);
    const findings = evaluateMetaFindings(signals);

    return findings.map((finding) => ({
      organizationId,
      auditId,
      title: finding.title,
      description: finding.description,
      category: finding.category,
      impactScore: finding.impactScore,
      effortScore: finding.effortScore,
      confidenceScore: finding.confidenceScore,
      sourceData: this.buildMetaSourceData(finding),
      status: 'open' as const,
    }));
  }

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

    const auditResult = audit.resultJson as Record<string, unknown>;
    const siteAuditResult = auditResult?.site_audit as
      SiteAuditResult | undefined;

    const generated = hasSitePages(siteAuditResult)
      ? await this.generator.generateForSite({
          siteAuditResult,
          city: organization?.city,
          country: organization?.country,
        })
      : await this.generator.generate(auditResult, organization?.city);

    // RC-19: additive only — Meta findings never replace or reorder the SEO
    // opportunities above; they are read-only, social-presence evidence
    // (scoreInfluence: false) attached to the same completed audit.
    const metaOpportunities = await this.generateMetaOpportunities(
      organizationId,
      audit.id,
    );

    const opportunities = await this.prisma.$transaction([
      ...generated.map((opp) =>
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
      ...metaOpportunities.map((data) =>
        this.prisma.opportunity.create({ data }),
      ),
    ]);

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

    // RC-19: additive only, same as generateFromAudit() above.
    const metaOpportunities = await this.generateMetaOpportunities(
      organizationId,
      audit.id,
    );

    return this.prisma.$transaction([
      ...generated.map((opp) =>
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
      ...metaOpportunities.map((data) =>
        this.prisma.opportunity.create({ data }),
      ),
    ]);
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
