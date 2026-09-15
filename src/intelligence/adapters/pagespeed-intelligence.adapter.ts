import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PageSpeedInsightsResult } from '../../audits/audit-runner/audit-runner.service';
import {
  IntelligenceFinding,
  IntelligenceProviderAdapter,
  IntelligenceSignal,
} from '../intelligence.types';
import { findLatestCompletedAudit } from '../latest-audit.util';

function readPageSpeedResult(
  resultJson: Record<string, unknown> | null,
): PageSpeedInsightsResult | null {
  const siteAudit = resultJson?.site_audit as
    { pagespeed_insights?: PageSpeedInsightsResult | null } | undefined;
  return siteAudit?.pagespeed_insights ?? null;
}

/**
 * RC-21 — PageSpeed adapter. Normalizes the `PageSpeedInsightsResult`
 * (RC-10/RC-11) already embedded in `Audit.resultJson.site_audit` by the
 * audit pipeline — this NEVER calls the PageSpeed Insights API itself.
 * `collectSignal` reads the organization's most recent completed audit
 * (there is no per-organization "current" PageSpeed reading outside of an
 * audit); `collectFindings` reads the *specific* audit passed in context,
 * since opportunity generation is always about one exact audit.
 *
 * No finding rules are implemented here in RC-21 — PageSpeed evidence is
 * exposed as a signal only; `collectFindings` always returns `[]`.
 */
@Injectable()
export class PageSpeedIntelligenceAdapter implements IntelligenceProviderAdapter {
  readonly provider = 'pagespeed' as const;
  readonly readOnly = true;
  readonly scoreInfluence = false;

  constructor(private readonly prisma: PrismaService) {}

  async collectSignal(organizationId: string): Promise<IntelligenceSignal> {
    const audit = await findLatestCompletedAudit(this.prisma, organizationId);
    const pageSpeed = readPageSpeedResult(audit?.resultJson ?? null);

    if (!pageSpeed) {
      return {
        provider: this.provider,
        status: 'unavailable',
        organizationId,
        observedAt: null,
        readOnly: this.readOnly,
        scoreInfluence: this.scoreInfluence,
        data: null,
        unavailableReason: audit ? 'no_pagespeed_data' : 'no_audit',
      };
    }

    return {
      provider: this.provider,
      status: pageSpeed.status === 'ok' ? 'ok' : 'unavailable',
      organizationId,
      observedAt: pageSpeed.fetchedAt ? new Date(pageSpeed.fetchedAt) : null,
      readOnly: this.readOnly,
      scoreInfluence: this.scoreInfluence,
      data: pageSpeed.status === 'ok' ? pageSpeed : null,
      unavailableReason: pageSpeed.unavailableReason,
    };
  }

  // Trailing params (organizationId, context) are unused and deliberately
  // omitted — TS structurally satisfies IntelligenceProviderAdapter with a
  // shorter implementation.
  // eslint-disable-next-line @typescript-eslint/require-await -- interface requires a Promise; PageSpeed has no finding rules in RC-21.
  async collectFindings(): Promise<IntelligenceFinding[]> {
    return [];
  }
}
