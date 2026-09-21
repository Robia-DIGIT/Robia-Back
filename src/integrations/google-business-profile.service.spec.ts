import { ConfigService } from '@nestjs/config';
import {
  BadGatewayException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleBusinessProfileService } from './google-business-profile.service';

function callArgs<T>(mock: jest.Mock): T[] {
  return (mock.mock.calls as unknown as Array<[T]>).map(([value]) => value);
}

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
    $transaction: jest.Mock;
    organization: { findFirst: jest.Mock };
    location: { findFirst: jest.Mock };
    googleBusinessProfileConnection: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      delete: jest.Mock;
    };
    googleBusinessProfileLocation: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
      count: jest.Mock;
    };
  };
  let service: GoogleBusinessProfileService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(),
      organization: { findFirst: jest.fn() },
      location: { findFirst: jest.fn() },
      googleBusinessProfileConnection: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn(),
      },
      googleBusinessProfileLocation: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
        count: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );
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
        new Response(
          JSON.stringify({ sub: 'google-sub-1', email: 'owner@example.com' }),
          {
            status: 200,
          },
        ),
      );

    await service.completeAuthorization('code', state);
    expect(capturedCreate?.encryptedRefreshToken).toMatch(/^v1\./);
    expect(capturedCreate?.encryptedRefreshToken).not.toContain(
      'refresh-secret',
    );
    expect(capturedCreate?.googleAccountEmail).toBe('owner@example.com');
  });

  it('reuses an existing refresh token only for the exact same Google subject', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('existing-refresh');
    const state = new URL(
      service.getAuthorizationUrl('org-1', 'user-1'),
    ).searchParams.get('state')!;
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      organizationId: 'org-1',
      googleAccountSubject: 'subject-1',
      encryptedRefreshToken: encrypted,
    });
    prisma.googleBusinessProfileConnection.upsert.mockResolvedValue({
      id: 'conn-1',
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access',
            scope: `openid email ${'https://www.googleapis.com/auth/business.manage'}`,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sub: 'subject-1', email: 'same@example.com' }),
          { status: 200 },
        ),
      );

    await service.completeAuthorization('code', state);

    const [{ update }] = callArgs<{
      update: { encryptedRefreshToken: string };
    }>(prisma.googleBusinessProfileConnection.upsert);
    expect(update.encryptedRefreshToken).toBe(encrypted);
    expect(
      prisma.googleBusinessProfileLocation.deleteMany,
    ).not.toHaveBeenCalled();
  });

  it('rotates the refresh token without clearing mirrors when the Google subject is unchanged', async () => {
    const state = new URL(
      service.getAuthorizationUrl('org-1', 'user-1'),
    ).searchParams.get('state')!;
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      googleAccountSubject: 'subject-1',
      encryptedRefreshToken: 'encrypted-old',
    });
    prisma.googleBusinessProfileConnection.upsert.mockResolvedValue({
      id: 'conn-1',
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access',
            refresh_token: 'rotated-refresh',
            scope:
              'openid email https://www.googleapis.com/auth/business.manage',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sub: 'subject-1', email: 'same@example.com' }),
          { status: 200 },
        ),
      );

    await service.completeAuthorization('code', state);

    const [{ update }] = callArgs<{
      update: {
        encryptedRefreshToken: string;
        lastSyncedAt?: null;
      };
    }>(prisma.googleBusinessProfileConnection.upsert);
    expect(update.encryptedRefreshToken).toMatch(/^v1\./);
    expect(update.encryptedRefreshToken).not.toBe('encrypted-old');
    expect(update.lastSyncedAt).toBeUndefined();
    expect(
      prisma.googleBusinessProfileLocation.deleteMany,
    ).not.toHaveBeenCalled();
  });

  it('refuses a different Google subject when no new refresh token is returned', async () => {
    const state = new URL(
      service.getAuthorizationUrl('org-1', 'user-1'),
    ).searchParams.get('state')!;
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      googleAccountSubject: 'old-subject',
      encryptedRefreshToken: 'encrypted-old',
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access',
            scope: `openid email ${'https://www.googleapis.com/auth/business.manage'}`,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sub: 'new-subject', email: 'new@example.com' }),
          { status: 200 },
        ),
      );

    await expect(
      service.completeAuthorization('code', state),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(
      prisma.googleBusinessProfileConnection.upsert,
    ).not.toHaveBeenCalled();
  });

  it('atomically clears old mirrors when a different Google subject supplies a new refresh token', async () => {
    const state = new URL(
      service.getAuthorizationUrl('org-1', 'user-1'),
    ).searchParams.get('state')!;
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      googleAccountSubject: 'old-subject',
      encryptedRefreshToken: 'encrypted-old',
    });
    prisma.googleBusinessProfileConnection.upsert.mockResolvedValue({
      id: 'conn-1',
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access',
            refresh_token: 'new-refresh',
            scope: `openid email ${'https://www.googleapis.com/auth/business.manage'}`,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sub: 'new-subject', email: 'new@example.com' }),
          { status: 200 },
        ),
      );

    await service.completeAuthorization('code', state);

    const [{ update }] = callArgs<{
      update: { googleAccountSubject: string; lastSyncedAt: null };
    }>(prisma.googleBusinessProfileConnection.upsert);
    expect(update).toMatchObject({
      googleAccountSubject: 'new-subject',
      lastSyncedAt: null,
    });
    expect(
      prisma.googleBusinessProfileLocation.deleteMany,
    ).toHaveBeenCalledWith({
      where: { connectionId: 'conn-1' },
    });
  });

  it('never exposes old-account mirrors when the first synchronization of a new account fails', async () => {
    const state = new URL(
      service.getAuthorizationUrl('org-1', 'user-1'),
    ).searchParams.get('state')!;
    const encryptedNew = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('new-refresh');
    prisma.organization.findFirst.mockResolvedValue({ id: 'org-1' });
    prisma.googleBusinessProfileConnection.findUnique
      .mockResolvedValueOnce({
        id: 'conn-1',
        googleAccountSubject: 'old-subject',
        encryptedRefreshToken: 'encrypted-old',
      })
      .mockResolvedValueOnce({
        id: 'conn-1',
        organizationId: 'org-1',
        googleAccountSubject: 'new-subject',
        encryptedRefreshToken: encryptedNew,
        lastSyncedAt: null,
      });
    prisma.googleBusinessProfileConnection.upsert.mockResolvedValue({
      id: 'conn-1',
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'oauth-access',
            refresh_token: 'new-refresh',
            scope:
              'openid email https://www.googleapis.com/auth/business.manage',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sub: 'new-subject', email: 'new@example.com' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'sync-access' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));

    await service.completeAuthorization('code', state);
    await expect(service.syncLocations('org-1')).rejects.toBeInstanceOf(
      BadGatewayException,
    );

    expect(
      prisma.googleBusinessProfileLocation.deleteMany,
    ).toHaveBeenCalledTimes(1);
    expect(
      prisma.googleBusinessProfileLocation.deleteMany,
    ).toHaveBeenCalledWith({
      where: { connectionId: 'conn-1' },
    });
    expect(prisma.googleBusinessProfileLocation.upsert).not.toHaveBeenCalled();
  });

  it('synchronizes real account locations and removes stale mirrors only after successful reads', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('refresh');
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      organizationId: 'org-1',
      encryptedRefreshToken: encrypted,
      lastSyncedAt: null,
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

  // RC-38 "fiche complète" — every field Google returns for a location
  // must actually reach the row, not just the handful the original
  // integration extracted (title/category/address/phone).
  it('extracts every field of a Google location into the mirror row', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('refresh');
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      organizationId: 'org-1',
      encryptedRefreshToken: encrypted,
      lastSyncedAt: null,
    });
    let capturedCreate: Record<string, unknown> | undefined;
    prisma.googleBusinessProfileLocation.upsert.mockImplementation(
      (args: { create: Record<string, unknown> }) => {
        capturedCreate = args.create;
        return Promise.resolve({});
      },
    );
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
                languageCode: 'fr',
                title: 'ROBIA Analakely',
                storeCode: 'STORE-1',
                storefrontAddress: { locality: 'Antananarivo' },
                phoneNumbers: {
                  primaryPhone: '+261 34 00 000 00',
                  additionalPhones: ['+261 34 11 111 11'],
                },
                websiteUri: 'https://robia.example.com',
                categories: {
                  primaryCategory: { displayName: 'Agence marketing' },
                  additionalCategories: [{ displayName: 'Consultant SEO' }],
                },
                regularHours: {
                  periods: [
                    {
                      openDay: 'MONDAY',
                      openTime: { hours: 9 },
                      closeDay: 'MONDAY',
                      closeTime: { hours: 18 },
                    },
                  ],
                },
                specialHours: { specialHourPeriods: [] },
                moreHours: [{ hoursTypeId: 'DELIVERY', periods: [] }],
                serviceArea: { businessType: 'CUSTOMER_LOCATION_ONLY' },
                labels: ['VIP'],
                latlng: { latitude: -18.9, longitude: 47.5 },
                openInfo: { status: 'OPEN' },
                metadata: { mapsUri: 'https://maps.google.com/?cid=1' },
                profile: { description: 'Une agence marketing locale.' },
              },
            ],
          }),
          { status: 200 },
        ),
      );

    await service.syncLocations('org-1');

    expect(capturedCreate).toMatchObject({
      languageCode: 'fr',
      storeCode: 'STORE-1',
      additionalPhones: ['+261 34 11 111 11'],
      additionalCategories: ['Consultant SEO'],
      description: 'Une agence marketing locale.',
      regularHours: {
        periods: [
          {
            openDay: 'MONDAY',
            openTime: { hours: 9 },
            closeDay: 'MONDAY',
            closeTime: { hours: 18 },
          },
        ],
      },
      specialHours: { specialHourPeriods: [] },
      moreHours: [{ hoursTypeId: 'DELIVERY', periods: [] }],
      serviceArea: { businessType: 'CUSTOMER_LOCATION_ONLY' },
      labels: ['VIP'],
      latitude: -18.9,
      longitude: 47.5,
      openStatus: 'OPEN',
    });
  });

  // A zero-account response is never distinguishable from "the accounts
  // endpoint had a blip" from inside this service — deleting on it would
  // wipe every previously synced mirror (and every ROBIA link riding on
  // it) the moment that happens. It must be a safe no-op for existing
  // data, not treated as "this Google user really has nothing".
  it('never deletes previously synced locations when the accounts response comes back empty', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('refresh');
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      organizationId: 'org-1',
      encryptedRefreshToken: encrypted,
      lastSyncedAt: new Date('2026-09-20T10:00:00Z'),
    });
    prisma.googleBusinessProfileConnection.update.mockResolvedValue({});
    prisma.googleBusinessProfileLocation.count.mockResolvedValue(3);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accounts: [] }), { status: 200 }),
      );

    await expect(service.syncLocations('org-1')).resolves.toMatchObject({
      synced: false,
      status: 'partial',
      locationCount: 3,
    });
    expect(
      prisma.googleBusinessProfileLocation.deleteMany,
    ).not.toHaveBeenCalled();
    expect(prisma.googleBusinessProfileLocation.count).toHaveBeenCalledWith({
      where: { connectionId: 'conn-1' },
    });
    expect(
      callArgs<{ data: { lastSyncedAt?: Date } }>(
        prisma.googleBusinessProfileConnection.updateMany,
      ).some(({ data }) => data.lastSyncedAt !== undefined),
    ).toBe(false);
  });

  it('reports a partial first attempt when Google returns no account and no mirror exists', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('refresh');
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      organizationId: 'org-1',
      encryptedRefreshToken: encrypted,
      lastSyncedAt: null,
    });
    prisma.googleBusinessProfileLocation.count.mockResolvedValue(0);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accounts: [] }), { status: 200 }),
      );

    await expect(service.syncLocations('org-1')).resolves.toEqual({
      synced: false,
      status: 'partial',
      locationCount: 0,
      syncedAt: null,
    });
    expect(
      prisma.googleBusinessProfileLocation.deleteMany,
    ).not.toHaveBeenCalled();
  });

  it('still reconciles normally when at least one account is observed, even if that account has zero locations', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('refresh');
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      organizationId: 'org-1',
      encryptedRefreshToken: encrypted,
      lastSyncedAt: null,
    });
    prisma.googleBusinessProfileConnection.update.mockResolvedValue({});
    prisma.googleBusinessProfileLocation.deleteMany.mockResolvedValue({
      count: 2,
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accounts: [{ name: 'accounts/123' }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ locations: [] }), { status: 200 }),
      );

    await expect(service.syncLocations('org-1')).resolves.toMatchObject({
      synced: true,
      locationCount: 0,
    });
    // An observed (even if empty) account is trusted: every previously
    // synced mirror for this connection is genuinely gone from Google.
    expect(
      prisma.googleBusinessProfileLocation.deleteMany,
    ).toHaveBeenCalledWith({ where: { connectionId: 'conn-1' } });
    expect(prisma.googleBusinessProfileLocation.count).not.toHaveBeenCalled();
  });

  it('rejects a concurrent synchronization before making any Google request', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('refresh');
    prisma.googleBusinessProfileConnection.findUnique
      .mockResolvedValueOnce({
        id: 'conn-1',
        organizationId: 'org-1',
        encryptedRefreshToken: encrypted,
      })
      .mockResolvedValueOnce({
        syncClaimedAt: new Date(),
        lastSyncAttemptAt: new Date(),
      });
    prisma.googleBusinessProfileConnection.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(service.syncLocations('org-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('recovers a synchronization whose durable lease expired after a crash', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('refresh');
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      organizationId: 'org-1',
      encryptedRefreshToken: encrypted,
      lastSyncedAt: null,
      lastSyncAttemptAt: new Date(Date.now() - 10 * 60 * 1000),
      syncClaimedAt: new Date(Date.now() - 10 * 60 * 1000),
      syncClaimToken: 'crashed-worker',
    });
    prisma.googleBusinessProfileLocation.deleteMany.mockResolvedValue({
      count: 0,
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accounts: [{ name: 'accounts/123' }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ locations: [] }), { status: 200 }),
      );

    await expect(service.syncLocations('org-1')).resolves.toMatchObject({
      synced: true,
      status: 'success',
    });
    const [claimArgs] = callArgs<{
      where: {
        OR: [{ syncClaimedAt: null }, { syncClaimedAt: { lt: Date } }];
      };
    }>(prisma.googleBusinessProfileConnection.updateMany);
    expect(claimArgs.where.OR[0]).toEqual({ syncClaimedAt: null });
    expect(claimArgs.where.OR[1].syncClaimedAt.lt).toBeInstanceOf(Date);
  });

  it('does not reconcile or delete anything when Google pagination fails midway', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('refresh');
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      organizationId: 'org-1',
      encryptedRefreshToken: encrypted,
      lastSyncedAt: null,
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accounts: [{ name: 'accounts/123' }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            locations: [{ name: 'locations/first', title: 'First' }],
            nextPageToken: 'next',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));

    await expect(service.syncLocations('org-1')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(prisma.googleBusinessProfileLocation.upsert).not.toHaveBeenCalled();
    expect(
      prisma.googleBusinessProfileLocation.deleteMany,
    ).not.toHaveBeenCalled();
    const releaseArgs = callArgs<{
      where: { id: string; syncClaimToken: string };
      data: {
        syncClaimedAt: null;
        syncClaimToken: null;
        lastSyncStatus: string;
      };
    }>(prisma.googleBusinessProfileConnection.updateMany).at(-1);
    expect(releaseArgs).toMatchObject({
      where: { id: 'conn-1' },
      data: {
        syncClaimedAt: null,
        syncClaimToken: null,
        lastSyncStatus: 'failed',
      },
    });
    expect(typeof releaseArgs?.where.syncClaimToken).toBe('string');
  });

  it('ignores a fully fetched result when the worker lost its claim before commit', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('refresh');
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      organizationId: 'org-1',
      encryptedRefreshToken: encrypted,
      lastSyncedAt: null,
    });
    prisma.googleBusinessProfileConnection.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accounts: [{ name: 'accounts/123' }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ locations: [{ name: 'locations/1' }] }), {
          status: 200,
        }),
      );

    await expect(service.syncLocations('org-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.googleBusinessProfileLocation.upsert).not.toHaveBeenCalled();
    expect(
      prisma.googleBusinessProfileLocation.deleteMany,
    ).not.toHaveBeenCalled();
  });

  it('deletes the local connection only after Google confirms revocation', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('refresh-secret');
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      encryptedRefreshToken: encrypted,
    });
    prisma.googleBusinessProfileConnection.delete.mockResolvedValue({});
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    await expect(service.disconnect('org-1')).resolves.toEqual({
      disconnected: true,
      revokedByGoogle: true,
    });
    expect(prisma.googleBusinessProfileConnection.delete).toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://oauth2.googleapis.com/revoke',
    );
  });

  it.each([400, 500])(
    'keeps the encrypted token when Google refuses revocation with %i so a retry remains possible',
    async (status) => {
      const encrypted = (
        service as unknown as { encrypt(value: string): string }
      ).encrypt('refresh-secret');
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted,
      });
      const warn = jest.spyOn(
        (
          service as unknown as {
            logger: { warn: (...args: unknown[]) => void };
          }
        ).logger,
        'warn',
      );
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('', { status }));

      await expect(service.disconnect('org-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(
        prisma.googleBusinessProfileConnection.delete,
      ).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('refresh-secret');
    },
  );

  it('keeps the encrypted token when revocation times out so the user can retry', async () => {
    const encrypted = (
      service as unknown as { encrypt(value: string): string }
    ).encrypt('refresh-secret');
    prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
      id: 'conn-1',
      encryptedRefreshToken: encrypted,
    });
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('timeout'));

    await expect(service.disconnect('org-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(
      prisma.googleBusinessProfileConnection.delete,
    ).not.toHaveBeenCalled();
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
