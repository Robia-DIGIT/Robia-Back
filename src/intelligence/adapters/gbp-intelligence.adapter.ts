import { Injectable } from '@nestjs/common';
import {
  IntelligenceFinding,
  IntelligenceProviderAdapter,
  IntelligenceSignal,
} from '../intelligence.types';

/**
 * RC-21 — Google Business Profile: contract-only placeholder.
 *
 * There is no GBP integration in RC-21 — no OAuth, no Prisma model, no
 * Graph/API client. This adapter exists so `IntelligenceProvider`'s `gbp`
 * member has a real, registered implementation behind `GET
 * /intelligence/status` (an explicit `not_connected` row) instead of a
 * silent gap, and so a future RC that adds the real integration only has
 * to replace this file, never invent the wiring.
 *
 * Deliberately zero I/O: no Prisma read, no network call, nothing —
 * `collectSignal`/`collectFindings` are pure functions of their
 * arguments. This is what "GBP absent => aucun appel réseau" means taken
 * literally, not just "no external HTTP call."
 */
@Injectable()
export class GbpIntelligenceAdapter implements IntelligenceProviderAdapter {
  readonly provider = 'gbp' as const;
  readonly readOnly = true;
  readonly scoreInfluence = false;

  // eslint-disable-next-line @typescript-eslint/require-await -- interface requires a Promise; this adapter has nothing to await by design.
  async collectSignal(organizationId: string): Promise<IntelligenceSignal> {
    return {
      provider: this.provider,
      status: 'not_connected',
      organizationId,
      observedAt: null,
      readOnly: this.readOnly,
      scoreInfluence: this.scoreInfluence,
      data: null,
      unavailableReason: 'not_connected',
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
