import { ConfigService } from '@nestjs/config';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleBusinessProfileService } from './google-business-profile.service';

describe('GoogleBusinessProfileService', () => {
  const env: Record<string, string> = {
    GOOGLE_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
    GOOGLE_BUSINESS_PROFILE_REDIRECT_URI:
      'https://api.robiacopilot.site/integrations/google/business-profile/callback',
    GOOGLE_TOKEN_ENCRYPTION_KEY: '11'.repeat(32),
    GOOGLE_OAUTH_STATE_SECRET: '22'.repeat(32),
    DASHBOARD_URL: 'https://app.robiacopilot.site',
  };
  let prisma: {
    organization: { findFirst: jest.Mock };
    location: { findFirst: jest.Mock };
    googleBusinessProfileConnection: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    googleBusinessProfileLocation: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let service: GoogleBusinessProfileService;

  beforeEach(() => {
    prisma = {
      organization: { findFirst: jest.fn() },
      location: { findFirst: jest.fn() },
      googleBusinessProfileConnection: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      googleBusinessProfileLocation: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    const config = {
      get: jest.fn((name: string, fallback?: string) => env[name] ?? fallback),
    };
    service = new GoogleBusinessProfileService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
    jest.restoreAllMocks();
  });

  it('builds an offline OAuth request with the GBP scope and dedicated callback', () => {
    const url = new URL(service.getAuthorizationUrl('org-1', 'user-1'));
    expect(url.searchParams.get('redirect_uri')).toBe(
      env.GOOGLE_BUSINESS_PROFILE_REDIRECT_URI,
    );
    expect(url.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/business.manage',
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toContain('.');
  });

  it('rejects a tampered state before reading any organization', async () => {
    const state = new URL(
      service.getAuthorizationUrl('org-1', 'user-1'),
    ).searchParams.get('state')!;
    await expect(
      service.completeAuthorization('code', `${state}x`),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
  });

  it('encrypts the refresh token and never persists its clear value', async () => {
    let capturedCreate:
      | { encryptedRefreshToken: string; googleAccountEmail: string | null }
      | undefined;
    const state = new URL(
      service.getAuthorizationUrl('org-1', 'user-1'),
    ).searchParams.get('state')!;
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue(null);
    prisma.googleBusinessProfileConnection.upsert.mockImplementation(
      (args: {
        create: {
          encryptedRefreshToken: string;
          googleAccountEmail: string | null;
        };
      }) => {
        capturedCreate = args.create;
        return Promise.resolve({ id: 'conn-1' });
      },
    );
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access',
            refresh_token: 'refresh-secret',
            scope:
              'openid email https://www.googleapis.com/auth/business.manage',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ email: 'owner@example.com' }), {
          status: 200,
        }),
      );

    await service.completeAuthorization('code', state);
    expect(capturedCreate?.encryptedRefreshToken).toMatch(/^v1\./);
    expect(capturedCreate?.encryptedRefreshToken).not.toContain(
      'refresh-secret',
    );
    expect(capturedCreate?.googleAccountEmail).toBe('owner@example.com');
  });

  it('synchronizes real account locations and removes stale mirrors only after successful reads', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('refresh');
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      organizationId: 'org-1',
      encryptedRefreshToken: encrypted,
    });
    prisma.googleBusinessProfileLocation.upsert.mockResolvedValue({});
    prisma.googleBusinessProfileLocation.deleteMany.mockResolvedValue({
      count: 0,
    });
    prisma.googleBusinessProfileConnection.update.mockResolvedValue({});
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accounts: [{ name: 'accounts/123', accountName: 'ROBIA' }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            locations: [
              {
                name: 'locations/456',
                title: 'ROBIA Analakely',
                storefrontAddress: { locality: 'Antananarivo' },
              },
            ],
          }),
          { status: 200 },
        ),
      );

    await expect(service.syncLocations('org-1')).resolves.toMatchObject({
      synced: true,
      locationCount: 1,
    });
    expect(prisma.googleBusinessProfileLocation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          connectionId_googleLocationName: {
            connectionId: 'conn-1',
            googleLocationName: 'locations/456',
          },
        },
      }),
    );
    expect(
      prisma.googleBusinessProfileLocation.deleteMany,
    ).toHaveBeenCalledWith({
      where: {
        connectionId: 'conn-1',
        googleLocationName: { notIn: ['locations/456'] },
      },
    });
  });

  it('never links a Google location to a ROBIA location from another organization', async () => {
    prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue({
      id: 'gbp-1',
    });
    prisma.location.findFirst.mockResolvedValue(null);
    await expect(
      service.linkLocation('org-1', 'gbp-1', 'location-org-2'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.googleBusinessProfileLocation.update).not.toHaveBeenCalled();
    expect(prisma.location.findFirst).toHaveBeenCalledWith({
      where: { id: 'location-org-2', organizationId: 'org-1' },
      select: { id: true },
    });
  });
});
