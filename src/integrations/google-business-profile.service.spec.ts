import { ConfigService } from '@nestjs/config';
import {
  BadGatewayException,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
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
      findMany: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      delete: jest.Mock;
    };
    googleBusinessProfileLocation: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
      count: jest.Mock;
    };
    googleBusinessProfileReview: {
      findMany: jest.Mock;
      upsert: jest.Mock;
      deleteMany: jest.Mock;
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
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn(),
      },
      googleBusinessProfileLocation: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn(),
        count: jest.fn(),
      },
      googleBusinessProfileReview: {
        findMany: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
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
      .mockResolvedValue({
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

  // RC-40.1 — Google's 30-day storage ceiling applies to the location fiche
  // too, not just reviews (RC-40): an organization that never re-clicks
  // "Synchroniser" must not keep a Google-sourced copy indefinitely. The
  // scheduled refresh below is the freshness-target side of that guarantee;
  // the absolute-ceiling side (purgeExpiredLocations, listLocations/
  // getStatus filtering) is covered in its own describe block further down.
  describe('refreshStaleLocations (scheduled)', () => {
    const encrypted = (service_: GoogleBusinessProfileService): string =>
      (service_ as unknown as { encrypt(value: string): string }).encrypt(
        'refresh',
      );

    it('selects a deterministic, bounded batch — id/organizationId only, oldest-first, capped, no refresh token ever loaded for the scan', async () => {
      prisma.googleBusinessProfileConnection.findMany.mockResolvedValue([]);
      await service.refreshStaleLocations();
      const [args] = callArgs<{
        where: unknown;
        select: Record<string, boolean>;
        orderBy: unknown[];
        take: number;
      }>(prisma.googleBusinessProfileConnection.findMany);
      expect(args.select).toEqual({ id: true, organizationId: true });
      expect(Object.keys(args.select)).not.toContain('encryptedRefreshToken');
      expect(args.orderBy).toEqual([
        { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
        { id: 'asc' },
      ]);
      expect(args.take).toBe(50);
    });

    it('is eligible only when never synced or stale beyond 24h, and excludes a recently-failed connection until its backoff window passes', async () => {
      prisma.googleBusinessProfileConnection.findMany.mockResolvedValue([]);
      await service.refreshStaleLocations();
      const [args] = callArgs<{
        where: {
          OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: Date } }];
          AND: [
            {
              OR: [
                { lastSyncStatus: { not: string } },
                { lastSyncAttemptAt: { lt: Date } },
              ];
            },
          ];
        };
      }>(prisma.googleBusinessProfileConnection.findMany);
      expect(args.where.OR[0]).toEqual({ lastSyncedAt: null });
      expect(args.where.OR[1].lastSyncedAt.lt).toBeInstanceOf(Date);
      expect(
        Date.now() - args.where.OR[1].lastSyncedAt.lt.getTime(),
      ).toBeCloseTo(24 * 60 * 60 * 1000, -3);
      const backoff = args.where.AND[0].OR;
      expect(backoff[0]).toEqual({ lastSyncStatus: { not: 'failed' } });
      expect(backoff[1].lastSyncAttemptAt.lt).toBeInstanceOf(Date);
      // A connection that failed within this window is skipped this tick
      // (avoiding an hourly hammer of a revoked token); once its last
      // attempt is older than the window, the same clause makes it
      // eligible again — recovery is automatic, not a separate code path.
      expect(
        Date.now() - backoff[1].lastSyncAttemptAt.lt.getTime(),
      ).toBeCloseTo(6 * 60 * 60 * 1000, -3);
    });

    it('resyncs a connection whose fiche has never been synced', async () => {
      prisma.googleBusinessProfileConnection.findMany.mockResolvedValue([
        { id: 'conn-1', organizationId: 'org-1' },
      ]);
      // The fresh, post-claim read is what actually supplies the token —
      // never the bare {id, organizationId} the scan discovered.
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        organizationId: 'org-1',
        encryptedRefreshToken: encrypted(service),
        lastSyncedAt: null,
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(0);
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'access' }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ accounts: [] }), { status: 200 }),
        );

      await service.refreshStaleLocations();

      expect(fetchSpy).toHaveBeenCalled();
    });

    it('resyncs a connection stale for more than 24h', async () => {
      prisma.googleBusinessProfileConnection.findMany.mockResolvedValue([
        { id: 'conn-1', organizationId: 'org-1' },
      ]);
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        organizationId: 'org-1',
        encryptedRefreshToken: encrypted(service),
        lastSyncedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(0);
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'access' }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ accounts: [] }), { status: 200 }),
        );

      await service.refreshStaleLocations();

      expect(fetchSpy).toHaveBeenCalled();
    });

    it('reuses the exact same claim/lease as a manual sync — a connection already claimed is skipped, not forced', async () => {
      prisma.googleBusinessProfileConnection.findMany.mockResolvedValue([
        { id: 'conn-1', organizationId: 'org-1' },
      ]);
      // Simulates a manual sync already holding the claim: the cron's own
      // claim attempt matches no row, so no fresh read is ever needed.
      prisma.googleBusinessProfileConnection.updateMany.mockResolvedValueOnce({
        count: 0,
      });
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValueOnce({
        syncClaimedAt: new Date(),
        lastSyncAttemptAt: new Date(),
      });
      const fetchSpy = jest.spyOn(global, 'fetch');

      await expect(service.refreshStaleLocations()).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("one connection's failure never stops the batch for the others", async () => {
      prisma.googleBusinessProfileConnection.findMany.mockResolvedValue([
        { id: 'conn-1', organizationId: 'org-1' },
        { id: 'conn-2', organizationId: 'org-2' },
      ]);
      // conn-1's claim fails (already claimed elsewhere); conn-2's claim
      // succeeds (falls through to the default mockResolvedValue) and its
      // post-claim fresh read supplies its token.
      prisma.googleBusinessProfileConnection.updateMany.mockResolvedValueOnce({
        count: 0,
      });
      prisma.googleBusinessProfileConnection.findUnique
        .mockResolvedValueOnce({
          syncClaimedAt: new Date(),
          lastSyncAttemptAt: new Date(),
        })
        .mockResolvedValue({
          id: 'conn-2',
          organizationId: 'org-2',
          encryptedRefreshToken: encrypted(service),
          lastSyncedAt: null,
        });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(0);
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'access' }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ accounts: [] }), { status: 200 }),
        );

      await expect(service.refreshStaleLocations()).resolves.toBeUndefined();
      // Only conn-2 ever reached Google: conn-1's claim rejection happened
      // before any fetch, and the batch still completed for conn-2.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    // RC-40.1 fix — the pre-claim snapshot race: the discovery scan above
    // never carries account-specific data (see the `select` assertion
    // above), so even if OAuth reconnects org-1 to a different Google
    // account between discovery and claim acquisition, there is no stale
    // token in scope to misuse — only the post-claim fresh read can ever
    // supply one, and it always reflects whichever account is current at
    // that moment.
    it('never uses a stale pre-claim account: a reconnection between discovery and claim acquisition is only ever observed through the fresh post-claim read', async () => {
      const encryptedAccountB = (
        service as unknown as { encrypt(value: string): string }
      ).encrypt('refresh-account-B');
      // The scan discovers only bare identifiers — structurally incapable
      // of carrying account A's now-superseded token forward.
      prisma.googleBusinessProfileConnection.findMany.mockResolvedValue([
        { id: 'conn-1', organizationId: 'org-1' },
      ]);
      // By the time the claim succeeds, OAuth has already reconnected
      // org-1 to account B — this is the only source of truth used.
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        organizationId: 'org-1',
        googleAccountSubject: 'account-B',
        encryptedRefreshToken: encryptedAccountB,
        lastSyncedAt: null,
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(0);
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'access' }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ accounts: [] }), { status: 200 }),
        );

      await service.refreshStaleLocations();

      expect(fetchSpy).toHaveBeenCalled();
      const tokenRequestBody = fetchSpy.mock.calls[0][1]?.body as
        URLSearchParams | undefined;
      expect(tokenRequestBody?.get('refresh_token')).toBe('refresh-account-B');
    });
  });

  // RC-40.1 — an honest freshness signal instead of silently trusting a
  // mirror that hasn't been resynced in a while, plus the absolute
  // compliance ceiling that actually guarantees the 30-day limit.
  describe('getStatus staleness', () => {
    it('reports fresh when last synced recently', async () => {
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        googleAccountEmail: 'owner@example.com',
        connectedAt: new Date(),
        lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000),
        lastSyncAttemptAt: new Date(),
        lastSyncStatus: 'success',
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(2);
      await expect(service.getStatus('org-1')).resolves.toMatchObject({
        connected: true,
        stale: false,
        expired: false,
        locationCount: 2,
      });
    });

    it('reports stale when never synced', async () => {
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        googleAccountEmail: 'owner@example.com',
        connectedAt: new Date(),
        lastSyncedAt: null,
        lastSyncAttemptAt: null,
        lastSyncStatus: 'never',
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(0);
      await expect(service.getStatus('org-1')).resolves.toMatchObject({
        connected: true,
        stale: true,
        expired: false,
      });
    });

    it('reports stale once the last sync is older than 24h', async () => {
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        googleAccountEmail: 'owner@example.com',
        connectedAt: new Date(),
        lastSyncedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        lastSyncAttemptAt: new Date(),
        lastSyncStatus: 'success',
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(2);
      await expect(service.getStatus('org-1')).resolves.toMatchObject({
        connected: true,
        stale: true,
        expired: false,
      });
    });

    it('is never stale or expired when not connected at all', async () => {
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue(null);
      await expect(service.getStatus('org-1')).resolves.toMatchObject({
        connected: false,
        stale: false,
        expired: false,
      });
    });
  });

  // RC-40.1 — the absolute compliance ceiling: the 24h refresh cadence is
  // only a freshness TARGET (missing it doesn't itself violate anything).
  // This is what actually guarantees Google's 30-day storage cap is never
  // exceeded, even under a permanently revoked token or a Google outage —
  // via LOCATIONS_ABSOLUTE_EXPIRY_MS (29 days, with margin), enforced both
  // at every read path and by the hourly purge cron.
  describe('absolute 30-day retention ceiling', () => {
    it('listLocations filters strictly by the absolute ceiling, for this organization only', async () => {
      prisma.googleBusinessProfileLocation.findMany.mockResolvedValue([]);
      await service.listLocations('org-1');
      const [args] = callArgs<{
        where: { organizationId: string; lastSyncedAt: { gt: Date } };
      }>(prisma.googleBusinessProfileLocation.findMany);
      expect(args.where.organizationId).toBe('org-1');
      expect(args.where.lastSyncedAt.gt).toBeInstanceOf(Date);
      expect(Date.now() - args.where.lastSyncedAt.gt.getTime()).toBeCloseTo(
        29 * 24 * 60 * 60 * 1000,
        -3,
      );
    });

    it('a Google failure under 30 days keeps the previous data — marked stale, not expired, still counted', async () => {
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        googleAccountEmail: 'owner@example.com',
        connectedAt: new Date(),
        lastSyncedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        lastSyncAttemptAt: new Date(),
        lastSyncStatus: 'failed',
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(2);
      await expect(service.getStatus('org-1')).resolves.toMatchObject({
        connected: true,
        stale: true,
        expired: false,
        locationCount: 2,
      });
    });

    it('a persistent failure beyond 30 days reports expired and serves no Google data', async () => {
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        googleAccountEmail: 'owner@example.com',
        connectedAt: new Date(),
        lastSyncedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        lastSyncAttemptAt: new Date(),
        lastSyncStatus: 'failed',
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(0);
      await expect(service.getStatus('org-1')).resolves.toMatchObject({
        connected: true,
        stale: true,
        expired: true,
        locationCount: 0,
      });
      const [countArgs] = callArgs<{
        where: { lastSyncedAt: { gt: Date } };
      }>(prisma.googleBusinessProfileLocation.count);
      expect(countArgs.where.lastSyncedAt.gt).toBeInstanceOf(Date);
    });

    it('a successful resync gives the fiche a fresh valid period, however old the previous one was', async () => {
      const encrypted = (
        service as unknown as { encrypt(value: string): string }
      ).encrypt('refresh');
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        organizationId: 'org-1',
        encryptedRefreshToken: encrypted,
        lastSyncedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
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
          new Response(
            JSON.stringify({ accounts: [{ name: 'accounts/123' }] }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              locations: [{ name: 'locations/1', title: 'A' }],
            }),
            { status: 200 },
          ),
        );

      const before = Date.now();
      await expect(service.syncLocations('org-1')).resolves.toMatchObject({
        synced: true,
        status: 'success',
      });
      const [releaseArgs] = callArgs<{ data: { lastSyncedAt?: Date } }>(
        prisma.googleBusinessProfileConnection.updateMany,
      )
        .filter((args) => args.data.lastSyncedAt !== undefined)
        .slice(-1);
      expect(releaseArgs.data.lastSyncedAt!.getTime()).toBeGreaterThanOrEqual(
        before,
      );
    });

    describe('purgeExpiredLocations', () => {
      it('deletes every fiche whose last sync is at or before the absolute ceiling', async () => {
        prisma.googleBusinessProfileLocation.deleteMany.mockResolvedValue({
          count: 5,
        });
        await service.purgeExpiredLocations();
        const [args] = callArgs<{ where: { lastSyncedAt: { lte: Date } } }>(
          prisma.googleBusinessProfileLocation.deleteMany,
        );
        expect(args.where.lastSyncedAt.lte).toBeInstanceOf(Date);
        expect(Date.now() - args.where.lastSyncedAt.lte.getTime()).toBeCloseTo(
          29 * 24 * 60 * 60 * 1000,
          -3,
        );
      });

      it('never deletes still-fresh data — logs nothing when there is nothing to purge', async () => {
        prisma.googleBusinessProfileLocation.deleteMany.mockResolvedValue({
          count: 0,
        });
        const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
        await service.purgeExpiredLocations();
        expect(logSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
      });
    });
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

  // RC-40 fix — reviews, read-only mirror per location, with a strict
  // <30-day retention window (never recomputing Google's own aggregate).
  describe('listReviews', () => {
    it('rejects a location that does not belong to this organization', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(null);
      await expect(
        service.listReviews('org-1', 'gbp-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        prisma.googleBusinessProfileReview.findMany,
      ).not.toHaveBeenCalled();
    });

    it('never returns an expired review, filtering strictly by expiresAt even before the purge cron runs', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue({
        id: 'gbp-1',
        organizationId: 'org-1',
        reviewsAverageRating: null,
        reviewsTotalReviewCount: null,
        reviewsLastSyncedAt: null,
        reviewsCacheExpiresAt: null,
      });
      prisma.googleBusinessProfileReview.findMany.mockResolvedValue([]);
      await service.listReviews('org-1', 'gbp-1');
      const [args] = callArgs<{
        where: { locationId: string; expiresAt: { gt: Date } };
      }>(prisma.googleBusinessProfileReview.findMany);
      expect(args.where.locationId).toBe('gbp-1');
      expect(args.where.expiresAt.gt).toBeInstanceOf(Date);
    });

    it('never selects googleReviewName, organizationId, locationId, or claim tokens for the API response', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue({
        id: 'gbp-1',
        organizationId: 'org-1',
        reviewsAverageRating: null,
        reviewsTotalReviewCount: null,
        reviewsLastSyncedAt: null,
        reviewsCacheExpiresAt: null,
      });
      prisma.googleBusinessProfileReview.findMany.mockResolvedValue([]);
      await service.listReviews('org-1', 'gbp-1');
      const [args] = callArgs<{ select: Record<string, unknown> }>(
        prisma.googleBusinessProfileReview.findMany,
      );
      // googleReviewName is Google's internal resource name, kept in the DB
      // only as the upsert idempotency key — never selected for the API.
      expect(args.select).not.toHaveProperty('googleReviewName');
      expect(args.select).not.toHaveProperty('organizationId');
      expect(args.select).not.toHaveProperty('locationId');
      for (const key of Object.keys(args.select)) {
        expect(key.toLowerCase()).not.toContain('claim');
      }
    });

    it("returns Google's own averageRating/totalReviewCount from a still-valid cache, never recomputed from the stored reviews", async () => {
      const lastSyncedAt = new Date();
      const expiresAt = new Date(Date.now() + 60_000);
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue({
        id: 'gbp-1',
        organizationId: 'org-1',
        reviewsAverageRating: 4.7,
        reviewsTotalReviewCount: 25,
        reviewsLastSyncedAt: lastSyncedAt,
        reviewsCacheExpiresAt: expiresAt,
      });
      prisma.googleBusinessProfileReview.findMany.mockResolvedValue([
        { id: 'r1', starRating: 5 },
        { id: 'r2', starRating: 1 },
      ]);
      // 4.7 comes straight from Google; a naive recomputation from the two
      // stored star ratings above would wrongly yield 3.
      await expect(service.listReviews('org-1', 'gbp-1')).resolves.toEqual({
        reviews: [
          { id: 'r1', starRating: 5 },
          { id: 'r2', starRating: 1 },
        ],
        averageRating: 4.7,
        totalReviewCount: 25,
        lastSyncedAt,
        expiresAt,
      });
    });

    it('reports an honest never-synced/expired state instead of serving a stale aggregate', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue({
        id: 'gbp-1',
        organizationId: 'org-1',
        reviewsAverageRating: 4.7,
        reviewsTotalReviewCount: 25,
        reviewsLastSyncedAt: new Date(Date.now() - 100_000),
        reviewsCacheExpiresAt: new Date(Date.now() - 1_000),
      });
      prisma.googleBusinessProfileReview.findMany.mockResolvedValue([]);
      await expect(service.listReviews('org-1', 'gbp-1')).resolves.toEqual({
        reviews: [],
        averageRating: null,
        totalReviewCount: null,
        lastSyncedAt: null,
        expiresAt: null,
      });
    });
  });

  describe('purgeExpiredReviews', () => {
    it('deletes every review whose retention window has passed', async () => {
      prisma.googleBusinessProfileReview.deleteMany.mockResolvedValue({
        count: 4,
      });
      await service.purgeExpiredReviews();
      const [args] = callArgs<{ where: { expiresAt: { lte: Date } } }>(
        prisma.googleBusinessProfileReview.deleteMany,
      );
      expect(args.where.expiresAt.lte).toBeInstanceOf(Date);
    });

    it('logs nothing when there is nothing to purge', async () => {
      prisma.googleBusinessProfileReview.deleteMany.mockResolvedValue({
        count: 0,
      });
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      await service.purgeExpiredReviews();
      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  describe('syncReviews', () => {
    const owningLocation = {
      id: 'gbp-1',
      organizationId: 'org-1',
      connectionId: 'conn-1',
      googleAccountName: 'accounts/123',
      googleLocationName: 'locations/456',
    };
    const encrypted = () =>
      (service as unknown as { encrypt(value: string): string }).encrypt(
        'refresh',
      );

    it('rejects a location from another organization before contacting Google', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(null);
      const fetchSpy = jest.spyOn(global, 'fetch');
      await expect(
        service.syncReviews('org-1', 'gbp-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a concurrent synchronization before making any Google request', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      prisma.googleBusinessProfileLocation.updateMany.mockResolvedValueOnce({
        count: 0,
      });
      prisma.googleBusinessProfileLocation.findUnique.mockResolvedValueOnce({
        reviewsSyncClaimedAt: new Date(),
        reviewsLastSyncAttemptAt: new Date(),
      });
      const fetchSpy = jest.spyOn(global, 'fetch');

      await expect(
        service.syncReviews('org-1', 'gbp-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('enforces a cooldown after a recent synchronization attempt', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      prisma.googleBusinessProfileLocation.updateMany.mockResolvedValueOnce({
        count: 0,
      });
      prisma.googleBusinessProfileLocation.findUnique.mockResolvedValueOnce({
        reviewsSyncClaimedAt: null,
        reviewsLastSyncAttemptAt: new Date(),
      });
      const fetchSpy = jest.spyOn(global, 'fetch');

      const error = await service
        .syncReviews('org-1', 'gbp-1')
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('recovers a synchronization whose claim lease expired after a crash', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      prisma.googleBusinessProfileReview.deleteMany.mockResolvedValue({
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
          new Response(JSON.stringify({ reviews: [] }), { status: 200 }),
        );

      await expect(
        service.syncReviews('org-1', 'gbp-1'),
      ).resolves.toMatchObject({ synced: true, reviewCount: 0 });

      const [claimArgs] = callArgs<{
        where: {
          OR: [
            { reviewsSyncClaimedAt: null },
            { reviewsSyncClaimedAt: { lt: Date } },
          ];
        };
      }>(prisma.googleBusinessProfileLocation.updateMany);
      expect(claimArgs.where.OR[0]).toEqual({ reviewsSyncClaimedAt: null });
      expect(claimArgs.where.OR[1].reviewsSyncClaimedAt.lt).toBeInstanceOf(
        Date,
      );
    });

    it('paginates every review, preserves Google’s own averageRating/totalReviewCount, and computes a 24h expiry', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      prisma.googleBusinessProfileReview.upsert.mockResolvedValue({});
      prisma.googleBusinessProfileReview.deleteMany.mockResolvedValue({
        count: 1,
      });
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
              reviews: [
                {
                  name: 'accounts/123/locations/456/reviews/r1',
                  reviewer: {
                    displayName: 'Client Satisfait',
                    profilePhotoUrl: 'https://example.com/p.jpg',
                  },
                  starRating: 'FIVE',
                  comment: 'Excellent service',
                  createTime: '2026-09-01T10:00:00Z',
                  updateTime: '2026-09-01T10:00:00Z',
                  reviewReply: {
                    comment: 'Merci !',
                    updateTime: '2026-09-02T10:00:00Z',
                  },
                },
              ],
              averageRating: 4.5,
              totalReviewCount: 12,
              nextPageToken: 'page-2',
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              reviews: [
                {
                  name: 'accounts/123/locations/456/reviews/r2',
                  starRating: 'STAR_RATING_UNSPECIFIED',
                },
              ],
              // Second page omits the aggregate — the last known value from
              // an earlier page must be kept, not overwritten with nothing.
            }),
            { status: 200 },
          ),
        );

      const result = await service.syncReviews('org-1', 'gbp-1');
      expect(result).toMatchObject({
        synced: true,
        reviewCount: 2,
        averageRating: 4.5,
        totalReviewCount: 12,
      });
      expect(result.expiresAt.getTime() - result.syncedAt.getTime()).toBe(
        24 * 60 * 60 * 1000,
      );

      const [firstCall] = callArgs<{
        where: {
          locationId_googleReviewName: {
            locationId: string;
            googleReviewName: string;
          };
        };
        create: Record<string, unknown>;
      }>(prisma.googleBusinessProfileReview.upsert);
      expect(firstCall.where.locationId_googleReviewName).toEqual({
        locationId: 'gbp-1',
        googleReviewName: 'accounts/123/locations/456/reviews/r1',
      });
      expect(firstCall.create).toMatchObject({
        organizationId: 'org-1',
        locationId: 'gbp-1',
        reviewerDisplayName: 'Client Satisfait',
        starRating: 5,
        comment: 'Excellent service',
        replyComment: 'Merci !',
      });
      expect(firstCall.create).not.toHaveProperty('reviewerPhotoUri');
      expect(firstCall.create.expiresAt).toBeInstanceOf(Date);

      const [secondCall] = callArgs<{ create: Record<string, unknown> }>(
        prisma.googleBusinessProfileReview.upsert,
      ).slice(1);
      expect(secondCall.create).toMatchObject({ starRating: null });

      expect(
        prisma.googleBusinessProfileReview.deleteMany,
      ).toHaveBeenCalledWith({
        where: {
          locationId: 'gbp-1',
          googleReviewName: {
            notIn: [
              'accounts/123/locations/456/reviews/r1',
              'accounts/123/locations/456/reviews/r2',
            ],
          },
        },
      });

      const releaseArgs = callArgs<{
        where: { id: string; reviewsSyncClaimToken: string };
        data: {
          reviewsAverageRating: number;
          reviewsTotalReviewCount: number;
          reviewsCacheExpiresAt: Date;
          reviewsSyncStatus: string;
        };
      }>(prisma.googleBusinessProfileLocation.updateMany).at(-1);
      expect(releaseArgs).toMatchObject({
        where: { id: 'gbp-1' },
        data: {
          reviewsAverageRating: 4.5,
          reviewsTotalReviewCount: 12,
          reviewsSyncStatus: 'success',
        },
      });
    });

    it('handles a fully-synced establishment with zero reviews correctly', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      prisma.googleBusinessProfileReview.deleteMany.mockResolvedValue({
        count: 3,
      });
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
              reviews: [],
              averageRating: 0,
              totalReviewCount: 0,
            }),
            { status: 200 },
          ),
        );

      await expect(
        service.syncReviews('org-1', 'gbp-1'),
      ).resolves.toMatchObject({
        synced: true,
        reviewCount: 0,
        averageRating: 0,
        totalReviewCount: 0,
      });
      expect(prisma.googleBusinessProfileReview.upsert).not.toHaveBeenCalled();
      expect(
        prisma.googleBusinessProfileReview.deleteMany,
      ).toHaveBeenCalledWith({ where: { locationId: 'gbp-1' } });
    });

    it('writes nothing when Google pagination fails midway', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
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
              reviews: [{ name: 'accounts/123/locations/456/reviews/r1' }],
              nextPageToken: 'page-2',
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 503 }));

      await expect(
        service.syncReviews('org-1', 'gbp-1'),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(prisma.googleBusinessProfileReview.upsert).not.toHaveBeenCalled();
      expect(
        prisma.googleBusinessProfileReview.deleteMany,
      ).not.toHaveBeenCalled();

      const releaseArgs = callArgs<{
        where: { id: string; reviewsSyncClaimToken: string };
        data: {
          reviewsSyncClaimedAt: null;
          reviewsSyncClaimToken: null;
          reviewsSyncStatus: string;
        };
      }>(prisma.googleBusinessProfileLocation.updateMany).at(-1);
      expect(releaseArgs).toMatchObject({
        where: { id: 'gbp-1' },
        data: {
          reviewsSyncClaimedAt: null,
          reviewsSyncClaimToken: null,
          reviewsSyncStatus: 'failed',
        },
      });
      expect(typeof releaseArgs?.where.reviewsSyncClaimToken).toBe('string');
    });

    it('ignores a fully fetched result when the worker lost its claim before commit', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      prisma.googleBusinessProfileLocation.updateMany
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
          new Response(
            JSON.stringify({
              reviews: [{ name: 'accounts/123/locations/456/reviews/r1' }],
            }),
            { status: 200 },
          ),
        );

      await expect(
        service.syncReviews('org-1', 'gbp-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.googleBusinessProfileReview.upsert).not.toHaveBeenCalled();
      expect(
        prisma.googleBusinessProfileReview.deleteMany,
      ).not.toHaveBeenCalled();
    });

    it('never logs the OAuth access token or review content', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      prisma.googleBusinessProfileReview.upsert.mockResolvedValue({});
      prisma.googleBusinessProfileReview.deleteMany.mockResolvedValue({
        count: 0,
      });
      const secretToken = 'super-secret-access-token-value';
      const secretComment =
        'This review contains a very private complaint about staff.';
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: secretToken }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              reviews: [
                {
                  name: 'accounts/123/locations/456/reviews/r1',
                  comment: secretComment,
                },
              ],
            }),
            { status: 200 },
          ),
        );
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation();

      await service.syncReviews('org-1', 'gbp-1');

      const everythingLogged = JSON.stringify([
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]);
      expect(everythingLogged).not.toContain(secretToken);
      expect(everythingLogged).not.toContain(secretComment);
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('getPerformanceMetrics', () => {
    const owningLocation = {
      id: 'gbp-1',
      organizationId: 'org-1',
      connectionId: 'conn-1',
      googleAccountName: 'accounts/123',
      googleLocationName: 'locations/456',
    };
    const encrypted = () =>
      (service as unknown as { encrypt(value: string): string }).encrypt(
        'refresh',
      );

    it('rejects a location from another organization before contacting Google', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(null);
      const fetchSpy = jest.spyOn(global, 'fetch');
      await expect(
        service.getPerformanceMetrics('org-1', 'gbp-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a concurrent performance read before contacting Google', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      prisma.googleBusinessProfileLocation.updateMany.mockResolvedValueOnce({
        count: 0,
      });
      prisma.googleBusinessProfileLocation.findUnique.mockResolvedValueOnce({
        performanceClaimedAt: new Date(),
        performanceLastAttemptAt: new Date(),
      });
      const fetchSpy = jest.spyOn(global, 'fetch');

      await expect(
        service.getPerformanceMetrics('org-1', 'gbp-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('enforces a cooldown after a recent performance read attempt', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      prisma.googleBusinessProfileLocation.updateMany.mockResolvedValueOnce({
        count: 0,
      });
      prisma.googleBusinessProfileLocation.findUnique.mockResolvedValueOnce({
        performanceClaimedAt: null,
        performanceLastAttemptAt: new Date(),
      });
      const fetchSpy = jest.spyOn(global, 'fetch');

      const error = await service
        .getPerformanceMetrics('org-1', 'gbp-1')
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('recovers a performance read whose claim lease expired after a crash', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'access' }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({}), { status: 200 }),
        );

      await expect(
        service.getPerformanceMetrics('org-1', 'gbp-1'),
      ).resolves.toMatchObject({ locationId: 'gbp-1' });

      const [claimArgs] = callArgs<{
        where: {
          OR: [
            { performanceClaimedAt: null },
            { performanceClaimedAt: { lt: Date } },
          ];
        };
      }>(prisma.googleBusinessProfileLocation.updateMany);
      expect(claimArgs.where.OR[0]).toEqual({ performanceClaimedAt: null });
      expect(claimArgs.where.OR[1].performanceClaimedAt.lt).toBeInstanceOf(
        Date,
      );
    });

    it('detects a lost claim before trusting a successful result, and never touches the new claimant’s token', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      // Worker A's initial claim succeeds. By the time A's Google call
      // returns, worker B has already reclaimed this location (A's lease
      // expired mid-flight), so A's release — scoped to A's own claim
      // token — matches no row.
      prisma.googleBusinessProfileLocation.updateMany
        .mockResolvedValueOnce({ count: 1 }) // A's claim
        .mockResolvedValueOnce({ count: 0 }); // A's release: B owns it now
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'access' }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({}), { status: 200 }),
        );

      await expect(
        service.getPerformanceMetrics('org-1', 'gbp-1'),
      ).rejects.toBeInstanceOf(ConflictException);

      const calls = callArgs<{
        data?: { performanceClaimToken?: string };
        where: { performanceClaimToken?: string };
      }>(prisma.googleBusinessProfileLocation.updateMany);
      const claimToken = calls[0]?.data?.performanceClaimToken;
      expect(typeof claimToken).toBe('string');
      // Every release attempt (the failed one and the finally-block retry)
      // is scoped to A's own token — it can never match B's differently
      // random token, so B's claim is left untouched.
      for (const call of calls.slice(1)) {
        expect(call.where.performanceClaimToken).toBe(claimToken);
      }
    });

    it('releases its claim after a failed Google request so a later read can proceed', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'access' }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 503 }));

      await expect(
        service.getPerformanceMetrics('org-1', 'gbp-1'),
      ).rejects.toBeInstanceOf(BadGatewayException);

      const releaseArgs = callArgs<{
        where: { id: string; performanceClaimToken: string };
        data: { performanceClaimedAt: null; performanceClaimToken: null };
      }>(prisma.googleBusinessProfileLocation.updateMany).at(-1);
      expect(releaseArgs).toMatchObject({
        where: { id: 'gbp-1' },
        data: { performanceClaimedAt: null, performanceClaimToken: null },
      });
    });

    it('requests every tracked metric over a 30-day window and aggregates the response', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      let requestedUrl: URL | undefined;
      jest
        .spyOn(global, 'fetch')
        .mockImplementationOnce(() =>
          Promise.resolve(
            new Response(JSON.stringify({ access_token: 'access' }), {
              status: 200,
            }),
          ),
        )
        .mockImplementationOnce((input: string) => {
          requestedUrl = new URL(input);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                multiDailyMetricTimeSeries: [
                  {
                    dailyMetricTimeSeries: [
                      {
                        dailyMetric: 'CALL_CLICKS',
                        timeSeries: {
                          datedValues: [
                            {
                              date: { year: 2026, month: 9, day: 1 },
                              value: '3',
                            },
                          ],
                        },
                      },
                      {
                        dailyMetric: 'WEBSITE_CLICKS',
                        timeSeries: {
                          datedValues: [
                            {
                              date: { year: 2026, month: 9, day: 1 },
                              value: '7',
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        });

      const result = await service.getPerformanceMetrics('org-1', 'gbp-1');

      expect(requestedUrl?.pathname).toContain(
        'locations/456:fetchMultiDailyMetricsTimeSeries',
      );
      expect(requestedUrl?.searchParams.getAll('dailyMetrics')).toEqual([
        'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
        'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
        'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
        'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
        'BUSINESS_CONVERSATIONS',
        'BUSINESS_DIRECTION_REQUESTS',
        'CALL_CLICKS',
        'WEBSITE_CLICKS',
      ]);
      expect(result.summary.calls).toBe(3);
      expect(result.summary.websiteClicks).toBe(7);
      expect(result.daily).toHaveLength(30);
      expect(
        result.daily.find((day) => day.date === '2026-09-01'),
      ).toMatchObject({ calls: 3, websiteClicks: 7 });
    });

    it('sums multiple DailyMetricTimeSeries for the same metric and date instead of overwriting', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
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
              multiDailyMetricTimeSeries: [
                {
                  // Google can split the same dailyMetric across several
                  // series (e.g. different dailySubEntityType) — both
                  // report CALL_CLICKS on the same date and must be added,
                  // not have the second overwrite the first.
                  dailyMetricTimeSeries: [
                    {
                      dailyMetric: 'CALL_CLICKS',
                      timeSeries: {
                        datedValues: [
                          {
                            date: { year: 2026, month: 9, day: 1 },
                            value: '3',
                          },
                        ],
                      },
                    },
                    {
                      dailyMetric: 'CALL_CLICKS',
                      timeSeries: {
                        datedValues: [
                          {
                            date: { year: 2026, month: 9, day: 1 },
                            value: '4',
                          },
                        ],
                      },
                    },
                    {
                      dailyMetric: 'WEBSITE_CLICKS',
                      timeSeries: {
                        datedValues: [
                          {
                            date: { year: 2026, month: 9, day: 1 },
                            value: 'not-a-number',
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            }),
            { status: 200 },
          ),
        );

      const result = await service.getPerformanceMetrics('org-1', 'gbp-1');

      const day = result.daily.find((entry) => entry.date === '2026-09-01');
      expect(day).toMatchObject({ calls: 7, websiteClicks: 0 });
      expect(Number.isNaN(day?.websiteClicks)).toBe(false);
      expect(result.summary.calls).toBe(7);
      expect(result.summary.websiteClicks).toBe(0);
    });

    it('reports every day as zero when Google returns no time series at all', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(
        owningLocation,
      );
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'conn-1',
        encryptedRefreshToken: encrypted(),
      });
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'access' }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({}), { status: 200 }),
        );

      const result = await service.getPerformanceMetrics('org-1', 'gbp-1');
      expect(result.summary).toEqual({
        impressions: 0,
        calls: 0,
        websiteClicks: 0,
        directionRequests: 0,
        conversations: 0,
      });
      expect(result.daily.every((day) => day.impressions === 0)).toBe(true);
    });
  });
});
