import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MetaService } from './meta.service';

describe('MetaService', () => {
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
  const config = {
    get: jest.fn((name: string) => values[name]),
  };
  const prisma = {
    organization: { findFirst: jest.fn() },
    metaConnection: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  let service: MetaService;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    config.get.mockImplementation((name: string) => values[name]);
    service = new MetaService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  it('builds a signed authorization request with read-only scopes only', () => {
    const url = new URL(service.getAuthorizationUrl('org-1', 'user-1'));

    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe('/v26.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe(values.META_APP_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(
      values.META_OAUTH_REDIRECT_URI,
    );
    expect(url.searchParams.get('scope')?.split(',')).toEqual([
      'pages_show_list',
      'pages_read_engagement',
      'instagram_basic',
    ]);
    expect(url.searchParams.get('scope')).not.toContain('manage_posts');
    expect(url.searchParams.get('scope')).not.toContain('content_publish');
    expect(url.searchParams.get('state')).toMatch(/^[^.]+\.[^.]+$/);
  });

  it('rejects a tampered OAuth state before reading the organization', async () => {
    const url = new URL(service.getAuthorizationUrl('org-1', 'user-1'));
    const state = `${url.searchParams.get('state')}x`;

    await expect(
      service.completeAuthorization('code', state),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
  });

  it('encrypts tokens and auto-selects the only accessible page', async () => {
    const state = new URL(
      service.getAuthorizationUrl('org-1', 'user-1'),
    ).searchParams.get('state')!;
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
    prisma.metaConnection.findUnique.mockResolvedValue(null);
    prisma.metaConnection.upsert.mockResolvedValue({ id: 'meta-1' });

    const responses: object[] = [
      { access_token: 'short-user-token' },
      { access_token: 'long-user-token-never-store-in-clear' },
      { id: 'meta-user-1', name: 'ROBIA Owner' },
      {
        data: [
          { permission: 'pages_show_list', status: 'granted' },
          { permission: 'pages_read_engagement', status: 'granted' },
          { permission: 'instagram_basic', status: 'granted' },
        ],
      },
      {
        data: [
          {
            id: 'page-1',
            name: 'ROBIA Copilot',
            access_token: 'page-token-never-store-in-clear',
            tasks: ['ANALYZE'],
            instagram_business_account: {
              id: 'ig-1',
              username: 'robiacopilot',
            },
          },
        ],
      },
    ];
    jest.spyOn(global, 'fetch').mockImplementation(() => {
      const payload = responses.shift() ?? {};
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    await expect(service.completeAuthorization('code', state)).resolves.toEqual(
      { connected: true },
    );

    expect(prisma.metaConnection.upsert).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      create: expect.objectContaining({
        organizationId: 'org-1',
        metaUserId: 'meta-user-1',
        selectedPageId: 'page-1',
        selectedInstagramAccountId: 'ig-1',
        encryptedUserAccessToken: expect.stringMatching(/^v1\./),
        encryptedPageAccessToken: expect.stringMatching(/^v1\./),
      }),
      update: expect.objectContaining({
        metaUserId: 'meta-user-1',
        selectedPageId: 'page-1',
        selectedInstagramAccountId: 'ig-1',
        encryptedUserAccessToken: expect.stringMatching(/^v1\./),
        encryptedPageAccessToken: expect.stringMatching(/^v1\./),
      }),
    });
    const serializedCall = JSON.stringify(prisma.metaConnection.upsert.mock.calls);
    expect(serializedCall).not.toContain('long-user-token-never-store-in-clear');
    expect(serializedCall).not.toContain('page-token-never-store-in-clear');
  });

  it('returns a token-free disconnected status and deletes only one organization', async () => {
    prisma.metaConnection.findUnique.mockResolvedValue(null);
    prisma.metaConnection.deleteMany.mockResolvedValue({ count: 1 });

    await expect(service.getStatus('org-1')).resolves.toEqual(
      expect.objectContaining({
        connected: false,
        readOnly: true,
        scoreInfluence: false,
      }),
    );
    await expect(service.disconnect('org-1')).resolves.toEqual({
      disconnected: true,
    });
    expect(prisma.metaConnection.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
    });
  });
});
