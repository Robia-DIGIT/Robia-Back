import { SearchConsoleIntelligenceAdapter } from './search-console-intelligence.adapter';
import { GoogleSearchConsoleService } from '../../integrations/google-search-console.service';

interface MockGoogleSearchConsole {
  getSearchConsoleSignalsForAudit: jest.Mock;
}

describe('SearchConsoleIntelligenceAdapter', () => {
  const organizationId = 'org-1';
  let googleSearchConsole: MockGoogleSearchConsole;
  let adapter: SearchConsoleIntelligenceAdapter;

  beforeEach(() => {
    googleSearchConsole = { getSearchConsoleSignalsForAudit: jest.fn() };
    adapter = new SearchConsoleIntelligenceAdapter(
      googleSearchConsole as unknown as GoogleSearchConsoleService,
    );
  });

  it('never calls anything other than getSearchConsoleSignalsForAudit — no second, live Google call', async () => {
    googleSearchConsole.getSearchConsoleSignalsForAudit.mockResolvedValue({
      status: 'unavailable',
      source: 'search_console',
      siteUrl: null,
      period: null,
      summary: null,
      lastSyncedAt: null,
      unavailableReason: 'not_connected',
    });

    await adapter.collectSignal(organizationId);

    expect(
      googleSearchConsole.getSearchConsoleSignalsForAudit,
    ).toHaveBeenCalledWith(organizationId);
    expect(
      googleSearchConsole.getSearchConsoleSignalsForAudit,
    ).toHaveBeenCalledTimes(1);
  });

  it('maps not_connected and no_property_selected reasons to their matching status', async () => {
    googleSearchConsole.getSearchConsoleSignalsForAudit.mockResolvedValue({
      status: 'unavailable',
      unavailableReason: 'not_connected',
    });
    expect((await adapter.collectSignal(organizationId)).status).toBe(
      'not_connected',
    );

    googleSearchConsole.getSearchConsoleSignalsForAudit.mockResolvedValue({
      status: 'unavailable',
      unavailableReason: 'no_property_selected',
    });
    expect((await adapter.collectSignal(organizationId)).status).toBe(
      'not_configured',
    );

    googleSearchConsole.getSearchConsoleSignalsForAudit.mockResolvedValue({
      status: 'unavailable',
      unavailableReason: 'not_synced_recently',
    });
    expect((await adapter.collectSignal(organizationId)).status).toBe(
      'unavailable',
    );
  });

  it('returns real summary data on ok, and null data whenever not ok', async () => {
    const okSignals = {
      status: 'ok' as const,
      source: 'search_console' as const,
      siteUrl: 'https://robiacopilot.site/',
      period: { startDate: '2026-08-01', endDate: '2026-08-28' },
      summary: { clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
      lastSyncedAt: new Date('2026-08-28T00:00:00.000Z'),
      unavailableReason: null,
    };
    googleSearchConsole.getSearchConsoleSignalsForAudit.mockResolvedValue(
      okSignals,
    );

    const signal = await adapter.collectSignal(organizationId);
    expect(signal.status).toBe('ok');
    expect(signal.data).toEqual(okSignals);
    expect(signal.observedAt).toEqual(okSignals.lastSyncedAt);
  });

  it('never generates any findings in RC-21', async () => {
    const findings = await adapter.collectFindings();
    expect(findings).toEqual([]);
  });
});
