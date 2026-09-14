import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MetaService } from './meta.service';

interface MetaServiceCrypto {
  encrypt(value: string): string;
}

describe('MetaService hardening', () => {
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

  it('scopes status reads and disconnect writes to the requested organization', async () => {
    prisma.metaConnection.findUnique
      .mockResolvedValueOnce({
        metaUserId: 'meta-user-a',
        metaUserName: 'Org A',
        grantedScopes: 'pages_show_list,pages_read_engagement,instagram_basic',
        selectedPageId: null,
        selectedPageName: null,
        selectedInstagramAccountId: null,
        selectedInstagramUsername: null,
        connectedAt: new Date('2026-09-14T00:00:00Z'),
        lastSyncedAt: null,
      })
      .mockResolvedValueOnce({
        metaUserId: 'meta-user-b',
        metaUserName: 'Org B',
        grantedScopes: 'pages_show_list,pages_read_engagement,instagram_basic',
        selectedPageId: null,
        selectedPageName: null,
        selectedInstagramAccountId: null,
        selectedInstagramUsername: null,
        connectedAt: new Date('2026-09-14T00:00:00Z'),
        lastSyncedAt: null,
      });
    prisma.metaConnection.deleteMany.mockResolvedValue({ count: 1 });

    const orgA = await service.getStatus('org-a');
    const orgB = await service.getStatus('org-b');
    await service.disconnect('org-b');

    expect(orgA.metaUserName).toBe('Org A');
    expect(orgB.metaUserName).toBe('Org B');
    expect(prisma.metaConnection.findUnique).toHaveBeenNthCalledWith(1, {
      where: { organizationId: 'org-a' },
      select: expect.any(Object),
    });
    expect(prisma.metaConnection.findUnique).toHaveBeenNthCalledWith(2, {
      where: { organizationId: 'org-b' },
      select: expect.any(Object),
    });
    expect(prisma.metaConnection.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-b' },
    });
  });

  it('returns accessible assets without exposing user or Page access tokens', async () => {
    const encryptedUserToken = (
      service as unknown as MetaServiceCrypto
    ).encrypt('org-b-user-token-never-return');

    prisma.metaConnection.findUnique.mockResolvedValue({
      encryptedUserAccessToken: encryptedUserToken,
      selectedPageId: 'page-1',
    });

    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'page-1',
              name: 'ROBIA B',
              access_token: 'page-token-never-return',
              tasks: ['ANALYZE'],
              instagram_business_account: {
                id: 'ig-1',
                username: 'robiab',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const assets = await service.listAssets('org-b');
    const serialized = JSON.stringify(assets);

    expect(prisma.metaConnection.findUnique).toHaveBeenCalledWith({
      where: { organizationId: 'org-b' },
    });
    expect(assets).toEqual([
      {
        pageId: 'page-1',
        pageName: 'ROBIA B',
        tasks: ['ANALYZE'],
        instagramAccount: { id: 'ig-1', username: 'robiab' },
        selected: true,
      },
    ]);
    expect(serialized).not.toContain('org-b-user-token-never-return');
    expect(serialized).not.toContain('page-token-never-return');
  });

  it('rejects a valid signed state when the organization is not owned by the signed user before calling Meta', async () => {
    const state = new URL(
      service.getAuthorizationUrl('org-a', 'user-a'),
    ).searchParams.get('state')!;
    prisma.organization.findFirst.mockResolvedValue(null);
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(
      service.completeAuthorization('authorization-code', state),
    ).rejects.toThrow('Organisation OAuth invalide.');

    expect(prisma.organization.findFirst).toHaveBeenCalledWith({
      where: { id: 'org-a', ownerId: 'user-a' },
      select: { id: true },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prisma.metaConnection.upsert).not.toHaveBeenCalled();
  });
});
