import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  GeneratedOpportunity,
  OpportunityGeneratorService,
} from './opportunity-generator/opportunity-generator.service';
import { N8nWebhookService } from '../integrations/n8n-webhook.service';
import { SiteAuditResult } from '../audits/audit-runner/audit-runner.service';
import { IntelligenceRegistryService } from '../intelligence/intelligence-registry.service';
import { IntelligenceFinding } from '../intelligence/intelligence.types';
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
    private readonly intelligence: IntelligenceRegistryService,
  ) {}

  // RC-21: source_data shape for a provider-originated opportunity (any
  // IntelligenceProvider — Meta today, others in the future). Deliberately
  // separate from buildSourceData()'s SEO-oriented shape (rule_code/severity/
  // priority_score/affected_urls) rather than overloading it — provider
  // findings have a different evidence model and must always self-identify
  // so nothing downstream can mistake them for score-influencing SEO
  // findings. Writes BOTH `provider` (RC-21's canonical field) and `source`
  // (RC-19's original Meta field, same value) — existing Meta opportunities
  // persisted before this refactor only have `source`, and isProviderSourceData()
  // below reads either, so this is purely additive: no already-persisted row
  // needs to change shape, and no reader needs a migration.
  //
  // `confidence` (Codex review): RC-19's MetaFinding carries 'observed' vs
  // 'heuristic' and the frontend renders a different label for each — RC-21
  // must keep persisting it, not just the generic provider fields. Omitted
  // entirely (never defaulted) for a provider/finding that doesn't set it.
  private buildProviderSourceData(finding: IntelligenceFinding) {
    return {
      version: 2,
      provider: finding.provider,
      source: finding.provider,
      ruleCode: finding.ruleCode,
      confidence: finding.confidence,
      evidence: finding.evidence,
      recommendation: finding.recommendation,
      scoreInfluence: finding.scoreInfluence,
    } as unknown as Prisma.InputJsonValue;
  }

  private buildProviderOpportunityData(
    organizationId: string,
    auditId: string,
    finding: IntelligenceFinding,
  ) {
    return {
      organizationId,
      auditId,
      title: finding.title,
      description: finding.description,
      category: finding.category,
      impactScore: finding.impactScore,
      effortScore: finding.effortScore,
      confidenceScore: finding.confidenceScore,
      sourceData: this.buildProviderSourceData(finding),
      status: 'open' as const,
    };
  }

  // RC-21: reads sourceData defensively (it is untrusted, persisted JSON —
  // same caveat as AuditsService.resultJson) to tell a provider-sourced
  // opportunity apart from an SEO one, without relying on Prisma's Json
  // path-filtering (unused elsewhere in this codebase). Accepts either the
  // RC-21 `provider` key or the RC-19 `source` key it replaces, so
  // opportunities persisted before this refactor are still recognized.
  private isProviderSourceData(sourceData: unknown): sourceData is {
    provider?: unknown;
    source?: unknown;
    ruleCode?: unknown;
  } {
    if (!sourceData || typeof sourceData !== 'object') {
      return false;
    }
    const data = sourceData as { provider?: unknown; source?: unknown };
    return typeof data.provider === 'string' || typeof data.source === 'string';
  }

  private providerRuleKey(data: {
    provider?: unknown;
    source?: unknown;
    ruleCode?: unknown;
  }): string | null {
    const provider = data.provider ?? data.source;
    if (typeof provider !== 'string' || typeof data.ruleCode !== 'string') {
      return null;
    }
    return `${provider}:${data.ruleCode}`;
  }

  // RC-21: identifies which (provider, ruleCode) pairs already have an
  // opportunity recorded for this audit — the stable identity a provider
  // finding carries across re-evaluations (see buildProviderSourceData).
  // Keying on the pair (not ruleCode alone) means two different providers
  // can never collide even if they happen to reuse the same rule string.
  // Used so a regeneration call can add newly-missing provider
  // opportunities without ever duplicating one that already exists.
  private async existingProviderRuleKeys(
    auditId: string,
  ): Promise<Set<string>> {
    const existing = await this.prisma.opportunity.findMany({
      where: { auditId },
      select: { sourceData: true },
    });
    const keys = new Set<string>();
    for (const opportunity of existing) {
      const data = opportunity.sourceData;
      if (this.isProviderSourceData(data)) {
        const key = this.providerRuleKey(data);
        if (key) keys.add(key);
      }
    }
    return keys;
  }

  // RC-21 (generalizes RC-19's syncMissingMetaOpportunities): called on the
  // idempotent "already generated" path — preserves every existing SEO and
  // provider opportunity (and anything already linked to them: actions,
  // documents, validations) untouched, and inserts only the provider
  // findings not yet represented for this audit. Never touches the SEO
  // generator or re-runs it. A single provider's collection failing never
  // aborts this: IntelligenceRegistryService isolates each adapter and
  // simply omits that provider's findings for this call.
  private async syncMissingProviderOpportunities(
    organizationId: string,
    auditId: string,
    auditResult: Record<string, unknown> | null,
  ) {
    const [existingKeys, findings] = await Promise.all([
      this.existingProviderRuleKeys(auditId),
      this.intelligence.collectFindings(organizationId, {
        auditId,
        auditResult,
      }),
    ]);
    const missing = findings.filter(
      (finding) => !existingKeys.has(`${finding.provider}:${finding.ruleCode}`),
    );
    if (missing.length === 0) {
      return;
    }
    await this.prisma.$transaction(
      missing.map((finding) =>
        this.prisma.opportunity.create({
          data: this.buildProviderOpportunityData(
            organizationId,
            auditId,
            finding,
          ),
        }),
      ),
    );
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

    // La génération SEO est idempotente : les opportunités peuvent déjà
    // avoir des actions, documents et validations liés qu'une régénération
    // détruirait. RC-21 : les opportunités provider manquantes sont
    // néanmoins ajoutées à un audit déjà généré (un provider a pu être
    // connecté après coup) — jamais de suppression ni de régénération du
    // SEO existant.
    if (existingOpportunityCount > 0) {
      await this.syncMissingProviderOpportunities(
        organizationId,
        audit.id,
        audit.resultJson as Record<string, unknown> | null,
      );
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

    // RC-21: additive only — provider findings never replace or reorder the
    // SEO opportunities above; they are read-only evidence (scoreInfluence:
    // false for every provider shipped in this RC) attached to the same
    // completed audit. A single provider failing never aborts this or the
    // SEO opportunities already computed above — IntelligenceRegistryService
    // isolates each adapter and simply omits that provider's findings.
    const providerFindings = await this.intelligence.collectFindings(
      organizationId,
      { auditId: audit.id, auditResult },
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
      ...providerFindings.map((finding) =>
        this.prisma.opportunity.create({
          data: this.buildProviderOpportunityData(
            organizationId,
            audit.id,
            finding,
          ),
        }),
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
      await this.syncMissingProviderOpportunities(
        organizationId,
        audit.id,
        audit.resultJson as Record<string, unknown> | null,
      );
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

    // RC-21: additive only, same as generateFromAudit() above.
    const providerFindings = await this.intelligence.collectFindings(
      organizationId,
      {
        auditId: audit.id,
        auditResult: audit.resultJson as Record<string, unknown> | null,
      },
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
      ...providerFindings.map((finding) =>
        this.prisma.opportunity.create({
          data: this.buildProviderOpportunityData(
            organizationId,
            audit.id,
            finding,
          ),
        }),
      ),
    ]);
  }

  // RC-19 (Codex review), generalized in RC-21: a plain `take: 5` over
  // SEO + provider opportunities combined let a full slate of SEO
  // opportunities silently evict every provider one from the listing — a
  // provider opportunity could be created in the database by
  // syncMissingProviderOpportunities() yet never appear here, and
  // disappear again after a reload. The listing must stay source-aware:
  // keep SEO's own top-5 cap unchanged, and always surface every provider
  // opportunity for this audit alongside it.
  async findAllForAudit(organizationId: string, auditId: string) {
    const opportunities = await this.prisma.opportunity.findMany({
      where: { organizationId, auditId },
      orderBy: { impactScore: 'desc' },
    });
    const seoOpportunities = opportunities.filter(
      (opportunity) => !this.isProviderSourceData(opportunity.sourceData),
    );
    const providerOpportunities = opportunities.filter((opportunity) =>
      this.isProviderSourceData(opportunity.sourceData),
    );
    return [...seoOpportunities.slice(0, 5), ...providerOpportunities];
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
