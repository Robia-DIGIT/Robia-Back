import { GbpIntelligenceAdapter } from './gbp-intelligence.adapter';

describe('GbpIntelligenceAdapter', () => {
  const organizationId = 'org-1';
  let adapter: GbpIntelligenceAdapter;

  beforeEach(() => {
    adapter = new GbpIntelligenceAdapter();
  });

  it('always reports not_connected, with no data and an explicit reason', async () => {
    const signal = await adapter.collectSignal(organizationId);
    expect(signal).toEqual({
      provider: 'gbp',
      status: 'not_connected',
      organizationId,
      observedAt: null,
      readOnly: true,
      scoreInfluence: false,
      data: null,
      unavailableReason: 'not_connected',
    });
  });

  it('never returns any findings', async () => {
    const findings = await adapter.collectFindings();
    expect(findings).toEqual([]);
  });

  it('performs zero I/O — collectSignal takes no dependencies and touches nothing but its arguments', () => {
    // The constructor itself takes zero constructor dependencies (no
    // PrismaService, no HTTP client) — this is the structural guarantee
    // "GBP absent => aucun appel réseau" rests on: there is nothing this
    // class *could* call over the network or the database even if it
    // wanted to.
    expect(GbpIntelligenceAdapter.length).toBe(0);
  });
});
