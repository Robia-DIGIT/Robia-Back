import { GbpIntelligenceAdapter } from './gbp-intelligence.adapter';
import { GoogleBusinessProfileService } from '../../integrations/google-business-profile.service';

describe('GbpIntelligenceAdapter', () => {
  const organizationId = 'org-1';
  let adapter: GbpIntelligenceAdapter;

  beforeEach(() => {
    adapter = new GbpIntelligenceAdapter({
      getIntelligenceSignal: jest.fn().mockResolvedValue({
        status: 'not_connected',
        observedAt: null,
        data: null,
      }),
    } as unknown as GoogleBusinessProfileService);
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

  it('reads the real GBP connection signal through the integration service', async () => {
    const service = {
      getIntelligenceSignal: jest.fn().mockResolvedValue({
        status: 'ok',
        observedAt: new Date('2026-09-21T10:00:00Z'),
        data: { locationCount: 2 },
      }),
    };
    const connected = new GbpIntelligenceAdapter(
      service as unknown as GoogleBusinessProfileService,
    );
    expect(await connected.collectSignal(organizationId)).toMatchObject({
      provider: 'gbp',
      status: 'ok',
      data: { locationCount: 2 },
      unavailableReason: null,
    });
    expect(service.getIntelligenceSignal).toHaveBeenCalledWith(organizationId);
  });
});
