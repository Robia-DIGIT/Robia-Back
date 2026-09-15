import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SeoScoreV2 } from '../../audits/audit-runner/audit-runner.service';
import {
  IntelligenceFinding,
  IntelligenceProviderAdapter,
  IntelligenceSignal,
} from '../intelligence.types';
import { findLatestCompletedAudit } from '../latest-audit.util';

function readSeoScoreV2(
  resultJson: Record<string, unknown> | null,
): SeoScoreV2 | null {
  const siteAudit = resultJson?.site_audit as
    { seo_score_v2?: SeoScoreV2 | null } | undefined;
  return siteAudit?.seo_score_v2 ?? null;
}

/**
 * RC-21 — SEO adapter: read-only introspection of the score the existing
 * Python engine (`seo_score_v2`, `python-service/app/agents/scoring.py`)
 * already computed and persisted on the audit. This adapter NEVER
 * computes, recomputes, or touches that score — it only reports whether a
 * recent one exists, exposing SEO as "a distinct internal source" inside
 * the aggregator per the RC-21 issue, never a second scoring engine.
 *
 * `collectFindings` always returns `[]`: RC-21 explicitly leaves the SEO
 * findings/opportunities pipeline (`OpportunityGeneratorService`)
 * untouched and separate — this adapter is not a replacement for it.
 */
@Injectable()
export class SeoIntelligenceAdapter implements IntelligenceProviderAdapter {
  readonly provider = 'seo' as const;
  readonly readOnly = true;
  readonly scoreInfluence = true;

  constructor(private readonly prisma: PrismaService) {}

  async collectSignal(organizationId: string): Promise<IntelligenceSignal> {
    const audit = await findLatestCompletedAudit(this.prisma, organizationId);
    if (!audit) {
      return {
        provider: this.provider,
        status: 'unavailable',
        organizationId,
        observedAt: null,
        readOnly: this.readOnly,
        scoreInfluence: this.scoreInfluence,
        data: null,
        unavailableReason: 'no_audit',
      };
    }

    const seoScoreV2 = readSeoScoreV2(audit.resultJson);
    if (!seoScoreV2) {
      // An audit exists, but predates seo_score_v2 (or used the legacy
      // single-page path) — real data, just an incomplete shape. Never
      // reported as 'unavailable' (which would wrongly imply no audit
      // ran) nor invented as 'ok' with a fabricated breakdown.
      return {
        provider: this.provider,
        status: 'partial',
        organizationId,
        observedAt: audit.completedAt,
        readOnly: this.readOnly,
        scoreInfluence: this.scoreInfluence,
        data: null,
        unavailableReason: 'legacy_audit_result',
      };
    }

    return {
      provider: this.provider,
      status: 'ok',
      organizationId,
      observedAt: audit.completedAt,
      readOnly: this.readOnly,
      scoreInfluence: this.scoreInfluence,
      data: seoScoreV2,
      unavailableReason: null,
    };
  }

  // Trailing params (organizationId, context) are unused and deliberately
  // omitted — TS structurally satisfies IntelligenceProviderAdapter with a
  // shorter implementation.
  // eslint-disable-next-line @typescript-eslint/require-await -- interface requires a Promise; the SEO findings pipeline is intentionally untouched by RC-21.
  async collectFindings(): Promise<IntelligenceFinding[]> {
    return [];
  }
}
