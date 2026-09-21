import { Injectable } from '@nestjs/common';
import {
  IntelligenceFinding,
  IntelligenceProviderAdapter,
  IntelligenceSignal,
} from '../intelligence.types';
import { GoogleBusinessProfileService } from '../../integrations/google-business-profile.service';

/**
 * Google Business Profile read-only adapter. The integration service owns
 * OAuth and synchronization; the Intelligence Core only consumes its latest
 * real connection/sync state and never fabricates metrics or affects SEO.
 */
@Injectable()
export class GbpIntelligenceAdapter implements IntelligenceProviderAdapter {
  readonly provider = 'gbp' as const;
  readonly readOnly = true;
  readonly scoreInfluence = false;

  constructor(private readonly businessProfile: GoogleBusinessProfileService) {}

  async collectSignal(organizationId: string): Promise<IntelligenceSignal> {
    const signal =
      await this.businessProfile.getIntelligenceSignal(organizationId);
    return {
      provider: this.provider,
      status: signal.status,
      organizationId,
      observedAt: signal.observedAt,
      readOnly: this.readOnly,
      scoreInfluence: this.scoreInfluence,
      data: signal.data,
      unavailableReason:
        signal.status === 'not_connected'
          ? 'not_connected'
          : signal.status === 'not_configured'
            ? 'not_synced'
            : null,
    };
  }

  // Trailing params (organizationId, context) are unused and deliberately
  // omitted — TS structurally satisfies IntelligenceProviderAdapter with a
  // shorter implementation.
  // eslint-disable-next-line @typescript-eslint/require-await -- interface requires a Promise; this adapter has nothing to await by design.
  async collectFindings(): Promise<IntelligenceFinding[]> {
    return [];
  }
}
