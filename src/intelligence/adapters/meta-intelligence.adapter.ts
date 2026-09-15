import { Injectable } from '@nestjs/common';
import { MetaService } from '../../integrations/meta.service';
import {
  evaluateMetaFindings,
  MetaFinding,
} from '../../integrations/meta-insights';
import {
  IntelligenceFinding,
  IntelligenceProviderAdapter,
  IntelligenceSignal,
} from '../intelligence.types';

/**
 * RC-21 — Meta adapter, wrapping RC-18/RC-19's existing `MetaService`
 * verbatim. No OAuth/Graph code is rewritten here: this is purely a
 * translation from `MetaAuditSignals`/`MetaFinding` (RC-18/RC-19's own
 * contract) into the unified `IntelligenceSignal`/`IntelligenceFinding`
 * shape.
 *
 * `collectFindings` ignores its `context` argument on purpose: Meta has no
 * background sync (RC-18 scope) and no per-audit persisted snapshot, so
 * — exactly like `OpportunitiesService.evaluateCurrentMetaFindings()`
 * before this refactor — it always reads Meta's *current* state via a
 * live, read-only Graph call, regardless of which audit is asking.
 */
@Injectable()
export class MetaIntelligenceAdapter implements IntelligenceProviderAdapter {
  readonly provider = 'meta' as const;
  readonly readOnly = true;
  readonly scoreInfluence = false;

  constructor(private readonly meta: MetaService) {}

  async collectSignal(organizationId: string): Promise<IntelligenceSignal> {
    // MetaService.getInsightSignals() never throws (RC-19 guarantee) — no
    // extra try/catch needed here, same as the pre-RC-21 call site.
    const signals = await this.meta.getInsightSignals(organizationId);
    return {
      provider: this.provider,
      status: signals.status === 'ok' ? 'ok' : this.mapUnavailable(signals),
      organizationId,
      observedAt: signals.lastSyncedAt,
      readOnly: this.readOnly,
      scoreInfluence: this.scoreInfluence,
      data: signals.status === 'ok' ? signals : null,
      unavailableReason: signals.unavailableReason,
    };
  }

  private mapUnavailable(signals: {
    connected: boolean;
    pageSelected: boolean;
    unavailableReason: string | null;
  }): IntelligenceSignal['status'] {
    if (!signals.connected) return 'not_connected';
    if (!signals.pageSelected) return 'not_configured';
    return 'unavailable';
  }

  // Trailing `context` param is unused — Meta has no per-audit snapshot, so
  // this always reads Meta's *current* state regardless of which audit is
  // asking (same as the pre-RC-21 call site).
  async collectFindings(
    organizationId: string,
  ): Promise<IntelligenceFinding[]> {
    const signals = await this.meta.getInsightSignals(organizationId);
    const findings = evaluateMetaFindings(
      signals,
      this.meta.getInsightsThresholds(),
    );
    return findings.map((finding) => this.toIntelligenceFinding(finding));
  }

  private toIntelligenceFinding(finding: MetaFinding): IntelligenceFinding {
    return {
      provider: this.provider,
      ruleCode: finding.ruleCode,
      title: finding.title,
      description: finding.description,
      category: finding.category,
      evidence: finding.evidence,
      recommendation: finding.recommendation,
      impactScore: finding.impactScore,
      effortScore: finding.effortScore,
      confidenceScore: finding.confidenceScore,
      scoreInfluence: finding.scoreInfluence,
    };
  }
}
