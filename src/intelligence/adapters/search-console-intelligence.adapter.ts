import { Injectable } from '@nestjs/common';
import { GoogleSearchConsoleService } from '../../integrations/google-search-console.service';
import {
  IntelligenceFinding,
  IntelligenceProviderAdapter,
  IntelligenceSignal,
} from '../intelligence.types';

/**
 * RC-21 — Search Console adapter, wrapping RC-13's existing
 * `GoogleSearchConsoleService.getSearchConsoleSignalsForAudit()` verbatim.
 * That method already never throws and never calls the live Google API —
 * it only reads whatever was already persisted the last time the
 * dashboard synced — so this adapter adds no new network behavior, just a
 * translation into the unified contract.
 *
 * No finding rules are implemented for Search Console in RC-21 (out of
 * scope — the issue only asks for Meta's existing rules to be
 * generalized); `collectFindings` always returns `[]`.
 */
@Injectable()
export class SearchConsoleIntelligenceAdapter implements IntelligenceProviderAdapter {
  readonly provider = 'search_console' as const;
  readonly readOnly = true;
  readonly scoreInfluence = false;

  constructor(
    private readonly googleSearchConsole: GoogleSearchConsoleService,
  ) {}

  async collectSignal(organizationId: string): Promise<IntelligenceSignal> {
    const signals =
      await this.googleSearchConsole.getSearchConsoleSignalsForAudit(
        organizationId,
      );
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
    unavailableReason: string | null;
  }): IntelligenceSignal['status'] {
    if (signals.unavailableReason === 'not_connected') return 'not_connected';
    if (signals.unavailableReason === 'no_property_selected') {
      return 'not_configured';
    }
    return 'unavailable';
  }

  // Trailing params (organizationId, context) are unused and deliberately
  // omitted — TS structurally satisfies IntelligenceProviderAdapter with a
  // shorter implementation.
  // eslint-disable-next-line @typescript-eslint/require-await -- interface requires a Promise; Search Console has no finding rules in RC-21.
  async collectFindings(): Promise<IntelligenceFinding[]> {
    return [];
  }
}
