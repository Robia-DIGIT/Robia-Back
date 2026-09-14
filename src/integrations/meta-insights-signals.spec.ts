import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MetaService } from './meta.service';

/**
 * RC-19 — tests for MetaService.getInsightSignals(), the new never-throws
 * evidence read this slice adds. Kept in its own file (not
 * meta.service.spec.ts) so it does not collide with Codex's parallel RC-18
 * hardening work on that file (see rc18/hardening-audit).
 */
describe('MetaService.getInsightSignals', () => {
  const values: Record<string, string> = {
    META_APP_ID: '1234567890',
    META_APP_SECRET: 'meta-secret',
    META_OAUTH_REDIRECT_URI:
      'https://api.robiacopilot.site/integrations/meta/callback',
    META_TOKEN_ENCRYPTION_KEY: 'c'.repeat(64),
    META_OAUTH_STATE_SECRET: 'd'.repeat(64),
    META_GRAPH_API_VERSION: 'v26.0',
    META_OAUTH_SCOPES: 'pages_show_list,pages_read_engagement,instagram_basic',
    META_GRAPH_TIMEOUT_MS: '10000',
    DASHBOARD_URL: 'https://app.robiacopilot.site',
  };
  const config = { get: jest.fn((name: string) => values[name]) };
  const prisma = { metaConnection: { findUnique: jest.fn() } };
  let service: MetaService;

  function encryptedToken(raw: string): string {
    return (service as unknown as { encrypt(v: string): string }).encrypt(raw);
  }

  function queueGraphResponses(payloads: unknown[]) {
    const queue = [...payloads];
    jest.spyOn(global, 'fetch').mockImplementation(() => {
      const payload = queue.shift() ?? {};
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    config.get.mockImplementation((name: string) => values[name]);
    service = new MetaService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  it('never calls Meta — reports not_connected when there is no connection at all', async () => {
    prisma.metaConnection.findUnique.mockResolvedValue(null);
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    const result = await service.getInsightSignals('org-1');

    expect(result).toEqual({
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
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("scopes every read to the caller's own organizationId and never returns another organization's Meta data", async () => {
    prisma.metaConnection.findUnique.mockImplementation(
      ({ where }: { where: { organizationId: string } }) =>
        Promise.resolve(
          where.organizationId === 'org-b'
            ? {
                selectedPageId: 'page-org-b',
                encryptedPageAccessToken: encryptedToken('org-b-token'),
                selectedInstagramAccountId: null,
                lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
              }
            : null,
        ),
    );
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    const orgAResult = await service.getInsightSignals('org-a');

    expect(prisma.metaConnection.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a' } }),
    );
    expect(orgAResult).toMatchObject({
      status: 'unavailable',
      connected: false,
      unavailableReason: 'not_connected',
    });
    expect(JSON.stringify(orgAResult)).not.toContain('org-b');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never throws — degrades to unavailable/temporarily_unavailable when the connection read itself rejects', async () => {
    prisma.metaConnection.findUnique.mockRejectedValue(new Error('db down'));

    await expect(service.getInsightSignals('org-1')).resolves.toMatchObject({
      status: 'unavailable',
      unavailableReason: 'temporarily_unavailable',
    });
  });

  it('reports no_page_selected, connected true, when a connection exists without a selected Page', async () => {
    prisma.metaConnection.findUnique.mockResolvedValue({
      selectedPageId: null,
      encryptedPageAccessToken: null,
      selectedInstagramAccountId: null,
      lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    const result = await service.getInsightSignals('org-1');

    expect(result).toMatchObject({
      status: 'unavailable',
      connected: true,
      pageSelected: false,
      unavailableReason: 'no_page_selected',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads a selected Page with no linked Instagram account, keeping missing counters null (never 0)', async () => {
    prisma.metaConnection.findUnique.mockResolvedValue({
      selectedPageId: 'page-1',
      encryptedPageAccessToken: encryptedToken('page-token-never-leaked'),
      selectedInstagramAccountId: null,
      lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    queueGraphResponses([
      {
        id: 'page-1',
        name: 'ROBIA Copilot',
        fan_count: null,
        followers_count: 118,
      },
    ]);

    const result = await service.getInsightSignals('org-1');

    expect(result.status).toBe('ok');
    expect(result.instagramLinked).toBe(false);
    expect(result.instagram).toBeNull();
    expect(result.recentMedia).toBeNull();
    expect(result.facebook).toEqual({
      fanCount: null,
      followersCount: 118,
      talkingAboutCount: null,
    });
  });

  it('reads Instagram profile and recent media when a professional account is linked', async () => {
    prisma.metaConnection.findUnique.mockResolvedValue({
      selectedPageId: 'page-1',
      encryptedPageAccessToken: encryptedToken('page-token-never-leaked'),
      selectedInstagramAccountId: 'ig-1',
      lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    queueGraphResponses([
      {
        id: 'page-1',
        fan_count: 120,
        followers_count: 118,
        talking_about_count: 4,
      },
      {
        id: 'ig-1',
        username: 'robiacopilot',
        followers_count: 340,
        follows_count: null,
        media_count: 12,
      },
      {
        data: [
          {
            id: 'media-1',
            timestamp: '2026-09-10T00:00:00.000Z',
            like_count: 3,
            comments_count: 1,
          },
        ],
      },
    ]);

    const result = await service.getInsightSignals('org-1');

    expect(result.status).toBe('ok');
    expect(result.instagramLinked).toBe(true);
    expect(result.instagram).toEqual({
      followersCount: 340,
      followsCount: null,
      mediaCount: 12,
    });
    expect(result.recentMedia).toEqual({
      observed: true,
      items: [
        {
          timestamp: '2026-09-10T00:00:00.000Z',
          likeCount: 3,
          commentsCount: 1,
        },
      ],
    });
  });

  it('marks recent media as not observed (never as an empty list) when the media read itself fails', async () => {
    prisma.metaConnection.findUnique.mockResolvedValue({
      selectedPageId: 'page-1',
      encryptedPageAccessToken: encryptedToken('page-token-never-leaked'),
      selectedInstagramAccountId: 'ig-1',
      lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    let call = 0;
    jest.spyOn(global, 'fetch').mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'page-1', fan_count: 10 }), {
            status: 200,
          }),
        );
      }
      if (call === 2) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'ig-1', followers_count: 5 }), {
            status: 200,
          }),
        );
      }
      // Media call fails (e.g. missing permission on Meta's side).
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: 'Permissions error' } }),
          {
            status: 403,
          },
        ),
      );
    });

    const result = await service.getInsightSignals('org-1');

    expect(result.status).toBe('ok');
    expect(result.recentMedia).toEqual({ observed: false, items: [] });
  });

  it('degrades the whole signal to unavailable when the Page profile read fails', async () => {
    prisma.metaConnection.findUnique.mockResolvedValue({
      selectedPageId: 'page-1',
      encryptedPageAccessToken: encryptedToken('page-token-never-leaked'),
      selectedInstagramAccountId: null,
      lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'boom' } }), {
        status: 500,
      }),
    );

    const result = await service.getInsightSignals('org-1');

    expect(result).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'temporarily_unavailable',
      pageSelected: true,
    });
  });

  it('never leaks the decrypted Page access token anywhere in the returned signals', async () => {
    const secretToken = 'page-token-super-secret-never-leaked';
    prisma.metaConnection.findUnique.mockResolvedValue({
      selectedPageId: 'page-1',
      encryptedPageAccessToken: encryptedToken(secretToken),
      selectedInstagramAccountId: 'ig-1',
      lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const capturedUrls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation((input) => {
      // graphGet() always calls fetch(url, ...) with a real URL instance.
      capturedUrls.push((input as URL).toString());
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'x', data: [] }), { status: 200 }),
      );
    });

    const result = await service.getInsightSignals('org-1');

    // The token legitimately appears as a query param on outbound Graph
    // requests (that's how Graph auth works) — but never in what this
    // method hands back to callers (opportunities, API responses, logs).
    expect(JSON.stringify(result)).not.toContain(secretToken);
    expect(capturedUrls.some((url) => url.includes(secretToken))).toBe(true);
  });

  it('RC-19 still requests read-only scopes only — no publish/write permission was added for insights', () => {
    const url = new URL(service.getAuthorizationUrl('org-1', 'user-1'));
    const scopes = url.searchParams.get('scope')?.split(',') ?? [];

    expect(scopes).toEqual([
      'pages_show_list',
      'pages_read_engagement',
      'instagram_basic',
    ]);
    expect(scopes).not.toContain('pages_manage_posts');
    expect(scopes).not.toContain('instagram_content_publish');
    scopes.forEach((scope) => {
      expect(scope).not.toMatch(/manage_posts|content_publish|publish/i);
    });
  });
});

describe('MetaService.getInsightsThresholds', () => {
  const values: Record<string, string> = {
    META_APP_ID: '1234567890',
    META_APP_SECRET: 'meta-secret',
    META_OAUTH_REDIRECT_URI:
      'https://api.robiacopilot.site/integrations/meta/callback',
    META_TOKEN_ENCRYPTION_KEY: 'c'.repeat(64),
    META_OAUTH_STATE_SECRET: 'd'.repeat(64),
  };
  const config = { get: jest.fn((name: string) => values[name]) };
  const prisma = { metaConnection: { findUnique: jest.fn() } };
  let service: MetaService;

  beforeEach(() => {
    jest.clearAllMocks();
    delete values.META_LOW_ACTIVITY_WINDOW_DAYS;
    delete values.META_LOW_ACTIVITY_MIN_POSTS;
    config.get.mockImplementation((name: string) => values[name]);
    service = new MetaService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  it('falls back to the documented default (30 days / 1 post) when unset', () => {
    expect(service.getInsightsThresholds()).toEqual({
      lowActivityWindowDays: 30,
      lowActivityMinPosts: 1,
    });
  });

  it('reads a valid, in-range configured threshold', () => {
    values.META_LOW_ACTIVITY_WINDOW_DAYS = '14';
    values.META_LOW_ACTIVITY_MIN_POSTS = '3';

    expect(service.getInsightsThresholds()).toEqual({
      lowActivityWindowDays: 14,
      lowActivityMinPosts: 3,
    });
  });

  it('clamps lowActivityMinPosts back to the default when configured above the 10-item recent-media fetch ceiling (Codex review)', () => {
    // getInsightSignals() only ever reads the 10 most recent Instagram
    // media items — a configured minimum above that could never be
    // satisfied and would make META_LOW_RECENT_ACTIVITY fire
    // unconditionally, a misleading always-on signal rather than a
    // genuine heuristic.
    values.META_LOW_ACTIVITY_MIN_POSTS = '25';

    expect(service.getInsightsThresholds().lowActivityMinPosts).toBe(1);
  });

  it('falls back to the default when the configured window is out of range or not a number', () => {
    values.META_LOW_ACTIVITY_WINDOW_DAYS = '0';
    expect(service.getInsightsThresholds().lowActivityWindowDays).toBe(30);

    values.META_LOW_ACTIVITY_WINDOW_DAYS = '9999';
    expect(service.getInsightsThresholds().lowActivityWindowDays).toBe(30);

    values.META_LOW_ACTIVITY_WINDOW_DAYS = 'not-a-number';
    expect(service.getInsightsThresholds().lowActivityWindowDays).toBe(30);
  });
});
