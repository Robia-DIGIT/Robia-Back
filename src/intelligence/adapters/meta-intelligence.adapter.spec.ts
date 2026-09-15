import { MetaIntelligenceAdapter } from './meta-intelligence.adapter';
import { MetaService } from '../../integrations/meta.service';

interface MockMeta {
  getInsightSignals: jest.Mock;
  getInsightsThresholds: jest.Mock;
}

describe('MetaIntelligenceAdapter', () => {
  const organizationId = 'org-1';
  let meta: MockMeta;
  let adapter: MetaIntelligenceAdapter;

  beforeEach(() => {
    meta = {
      getInsightSignals: jest.fn(),
      getInsightsThresholds: jest
        .fn()
        .mockReturnValue({ lowActivityWindowDays: 30, lowActivityMinPosts: 1 }),
    };
    adapter = new MetaIntelligenceAdapter(meta as unknown as MetaService);
  });

  describe('collectSignal', () => {
    it('maps a not-connected signal to status not_connected, with no data', async () => {
      meta.getInsightSignals.mockResolvedValue({
        status: 'unavailable',
        source: 'meta',
        readOnly: true,
        scoreInfluence: false,
        connected: false,
        pageSelected: false,
        instagramLinked: false,
        facebook: null,
        instagram: null,
        recentMedia: null,
        lastSyncedAt: null,
        unavailableReason: 'not_connected',
      });

      const signal = await adapter.collectSignal(organizationId);

      expect(signal.status).toBe('not_connected');
      expect(signal.data).toBeNull();
      expect(signal.scoreInfluence).toBe(false);
      expect(signal.readOnly).toBe(true);
      expect(signal.unavailableReason).toBe('not_connected');
    });

    it('maps a connected-but-no-page signal to status not_configured', async () => {
      meta.getInsightSignals.mockResolvedValue({
        status: 'unavailable',
        source: 'meta',
        readOnly: true,
        scoreInfluence: false,
        connected: true,
        pageSelected: false,
        instagramLinked: false,
        facebook: null,
        instagram: null,
        recentMedia: null,
        lastSyncedAt: null,
        unavailableReason: 'no_page_selected',
      });

      const signal = await adapter.collectSignal(organizationId);
      expect(signal.status).toBe('not_configured');
      expect(signal.data).toBeNull();
    });

    it('never fabricates a metric field the Graph API did not return — an absent counter stays null', async () => {
      const signals = {
        status: 'ok' as const,
        source: 'meta' as const,
        readOnly: true as const,
        scoreInfluence: false as const,
        connected: true,
        pageSelected: true,
        instagramLinked: false,
        facebook: {
          fanCount: null,
          followersCount: null,
          talkingAboutCount: null,
        },
        instagram: null,
        recentMedia: null,
        lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
        unavailableReason: null,
      };
      meta.getInsightSignals.mockResolvedValue(signals);

      const signal = await adapter.collectSignal(organizationId);

      expect(signal.status).toBe('ok');
      expect((signal.data as typeof signals).facebook?.fanCount).toBeNull();
      expect(
        (signal.data as typeof signals).facebook?.followersCount,
      ).toBeNull();
    });
  });

  describe('collectFindings', () => {
    it('returns no findings when Meta is not connected', async () => {
      meta.getInsightSignals.mockResolvedValue({
        status: 'unavailable',
        connected: false,
        pageSelected: false,
        instagramLinked: false,
        facebook: null,
        instagram: null,
        recentMedia: null,
        lastSyncedAt: null,
        unavailableReason: 'not_connected',
      });

      const findings = await adapter.collectFindings(organizationId);
      expect(findings).toEqual([]);
    });

    it('translates a MetaFinding into the unified IntelligenceFinding shape', async () => {
      meta.getInsightSignals.mockResolvedValue({
        status: 'unavailable',
        connected: true,
        pageSelected: true,
        instagramLinked: false,
        facebook: { fanCount: 10, followersCount: 10, talkingAboutCount: null },
        instagram: null,
        recentMedia: null,
        lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
        unavailableReason: null,
      });

      const findings = await adapter.collectFindings(organizationId);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        provider: 'meta',
        ruleCode: 'META_INSTAGRAM_NOT_LINKED',
        scoreInfluence: false,
      });
      expect(Array.isArray(findings[0].evidence)).toBe(true);
    });
  });
});
