import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleSearchConsoleService } from './google-search-console.service';

describe('GoogleSearchConsoleService', () => {
  const scope = 'https://www.googleapis.com/auth/webmasters.readonly';
  const values: Record<string, string> = {
    GOOGLE_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    GOOGLE_OAUTH_REDIRECT_URI:
      'https://api.robiacopilot.site/integrations/google/search-console/callback',
    GOOGLE_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
    GOOGLE_OAUTH_STATE_SECRET: 'b'.repeat(64),
    GOOGLE_SEARCH_CONSOLE_TIMEOUT_MS: '10000',
    DASHBOARD_URL: 'https://app.robiacopilot.site',
  };
  const config = {
    get: jest.fn((name: string, fallback?: string) => values[name] ?? fallback),
  };
  const prisma = {
    organization: { findFirst: jest.fn() },
    googleSearchConsoleConnection: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    googleSearchConsoleDailyMetric: { upsert: jest.fn() },
    $transaction: jest.fn(),
  };
  let service: GoogleSearchConsoleService;

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockImplementation(
      (name: string, fallback?: string) => values[name] ?? fallback,
    );
    service = new GoogleSearchConsoleService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  it('builds a signed, short-lived, read-only authorization request', () => {
    const url = new URL(service.getAuthorizationUrl('org-1', 'user-1'));

    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe(values.GOOGLE_OAUTH_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(
      values.GOOGLE_OAUTH_REDIRECT_URI,
    );
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining(['openid', 'email', scope]),
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toMatch(/^[^.]+\.[^.]+$/);
  });

  it('rejects a tampered OAuth state before reading the organization', async () => {
    const url = new URL(service.getAuthorizationUrl('org-1', 'user-1'));
    const state = `${url.searchParams.get('state')}x`;

    await expect(service.completeAuthorization('code', state)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
  });

  it('encrypts the refresh token and selects the only verified property', async () => {
    const state = new URL(
      service.getAuthorizationUrl('org-1', 'user-1'),
    ).searchParams.get('state')!;
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
    prisma.googleSearchConsoleConnection.findUnique.mockResolvedValue(null);
    prisma.googleSearchConsoleConnection.upsert.mockResolvedValue({ id: 'connection-1' });
    const responses = [
      {
        access_token: 'access-token',
        refresh_token: 'refresh-token-never-store-in-clear',
        scope: `openid email ${scope}`,
      },
      { email: 'owner@example.com' },
      {
        siteEntry: [
          {
            siteUrl: 'sc-domain:robiacopilot.site',
            permissionLevel: 'siteOwner',
          },
        ],
      },
    ];
    global.fetch = jest.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => responses.shift(),
    })) as unknown as typeof fetch;

    await expect(service.completeAuthorization('code', state)).resolves.toEqual({
      connected: true,
    });

    const data = prisma.googleSearchConsoleConnection.upsert.mock.calls[0][0].create;
    expect(data.organizationId).toBe('org-1');
    expect(data.googleAccountEmail).toBe('owner@example.com');
    expect(data.selectedSiteUrl).toBe('sc-domain:robiacopilot.site');
    expect(data.encryptedRefreshToken).toMatch(/^v1\./);
    expect(data.encryptedRefreshToken).not.toContain(
      'refresh-token-never-store-in-clear',
    );
  });

  it('returns a token-free disconnected status and deletes only one organization', async () => {
    prisma.googleSearchConsoleConnection.findUnique.mockResolvedValue(null);
    prisma.googleSearchConsoleConnection.deleteMany.mockResolvedValue({ count: 1 });

    await expect(service.getStatus('org-1')).resolves.toEqual(
      expect.objectContaining({ connected: false }),
    );
    await expect(service.disconnect('org-1')).resolves.toEqual({
      disconnected: true,
    });
    expect(prisma.googleSearchConsoleConnection.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
    });
  });
});
