import { Ga4IntelligenceAdapter } from './ga4-intelligence.adapter';
import { GoogleSearchConsoleService } from '../../integrations/google-search-console.service';

interface MockGoogleSearchConsole {
  getStatus: jest.Mock;
  getAnalyticsPerformance: jest.Mock;
}

describe('Ga4IntelligenceAdapter', () => {
  const organizationId = 'org-1';
  let googleSearchConsole: MockGoogleSearchConsole;
  let adapter: Ga4IntelligenceAdapter;

  beforeEach(() => {
    googleSearchConsole = {
      getStatus: jest.fn(),
      getAnalyticsPerformance: jest.fn(),
    };
    adapter = new Ga4IntelligenceAdapter(
      googleSearchConsole as unknown as GoogleSearchConsoleService,
    );
  });

  it('reports not_connected and makes no live Analytics call when there is no connection at all', async () => {
    googleSearchConsole.getStatus.mockResolvedValue({ connected: false });

    const signal = await adapter.collectSignal(organizationId);

    expect(signal.status).toBe('not_connected');
    expect(signal.data).toBeNull();
    expect(googleSearchConsole.getAnalyticsPerformance).not.toHaveBeenCalled();
  });

  it('reports not_configured and makes no live call when Analytics scope was never granted', async () => {
    googleSearchConsole.getStatus.mockResolvedValue({
      connected: true,
      analyticsAuthorized: false,
      selectedAnalyticsPropertyId: null,
      lastAnalyticsSyncedAt: null,
    });

    const signal = await adapter.collectSignal(organizationId);

    expect(signal.status).toBe('not_configured');
    expect(signal.unavailableReason).toBe('analytics_scope_not_granted');
    expect(googleSearchConsole.getAnalyticsPerformance).not.toHaveBeenCalled();
  });

  it('reports not_configured and makes no live call when authorized but no property is selected', async () => {
    googleSearchConsole.getStatus.mockResolvedValue({
      connected: true,
      analyticsAuthorized: true,
      selectedAnalyticsPropertyId: null,
      lastAnalyticsSyncedAt: null,
    });

    const signal = await adapter.collectSignal(organizationId);

    expect(signal.status).toBe('not_configured');
    expect(signal.unavailableReason).toBe('no_property_selected');
    expect(googleSearchConsole.getAnalyticsPerformance).not.toHaveBeenCalled();
  });

  it('calls the real, existing getAnalyticsPerformance() only when connected and configured, and returns its real data', async () => {
    googleSearchConsole.getStatus.mockResolvedValue({
      connected: true,
      analyticsAuthorized: true,
      selectedAnalyticsPropertyId: 'properties/123',
      lastAnalyticsSyncedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const performance = {
      propertyId: 'properties/123',
      propertyName: 'robiacopilot.site',
      startDate: '2026-08-01',
      endDate: '2026-08-28',
      summary: {
        activeUsers: 42,
        totalUsers: 50,
        sessions: 60,
        views: 100,
        engagementRate: 0.5,
      },
      daily: [],
      topPages: [],
      lastSyncedAt: new Date('2026-08-28T00:00:00.000Z'),
    };
    googleSearchConsole.getAnalyticsPerformance.mockResolvedValue(performance);

    const signal = await adapter.collectSignal(organizationId);

    expect(googleSearchConsole.getAnalyticsPerformance).toHaveBeenCalledWith(
      organizationId,
    );
    expect(signal.status).toBe('ok');
    expect(signal.data).toEqual(performance);
    expect(signal.observedAt).toEqual(performance.lastSyncedAt);
  });

  it('degrades to unavailable, never fabricating data, when the live call fails', async () => {
    googleSearchConsole.getStatus.mockResolvedValue({
      connected: true,
      analyticsAuthorized: true,
      selectedAnalyticsPropertyId: 'properties/123',
      lastAnalyticsSyncedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    googleSearchConsole.getAnalyticsPerformance.mockRejectedValue(
      new Error('Google API 500'),
    );

    const signal = await adapter.collectSignal(organizationId);

    expect(signal.status).toBe('unavailable');
    expect(signal.data).toBeNull();
    expect(signal.unavailableReason).toBe('temporarily_unavailable');
  });

  it('never generates any findings in RC-21', async () => {
    const findings = await adapter.collectFindings();
    expect(findings).toEqual([]);
  });
});
