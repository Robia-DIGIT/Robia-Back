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
      aggregate: jest.Mock;
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
        aggregate: jest
          .fn()
          .mockResolvedValue({ _count: 0, _min: { lastSyncedAt: null } }),
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

    it('selects a deterministic, bounded batch — id/organizationId only, attempt-recency-first, capped, no refresh token ever loaded for the scan', async () => {
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
      // Ordering fix — primarily by lastSyncAttemptAt (never-attempted
      // first), so a block of repeatedly-failing connections (whose
      // attempt timestamp keeps advancing to "now") can never starve out a
      // connection that hasn't had a first try yet. lastSyncedAt is only
      // the tiebreaker, id the final one.
      expect(args.orderBy).toEqual([
        { lastSyncAttemptAt: { sort: 'asc', nulls: 'first' } },
        { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
        { id: 'asc' },
      ]);
      expect(args.take).toBe(50);
    });

    it('is eligible only when never synced or stale beyond 24h; backs off a recently failed OR partial connection; excludes an actively-claimed one', async () => {
      prisma.googleBusinessProfileConnection.findMany.mockResolvedValue([]);
      await service.refreshStaleLocations();
      const [args] = callArgs<{
        where: {
          OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: Date } }];
          AND: [
            {
              OR: [
                { lastSyncStatus: { notIn: string[] } },
                { lastSyncAttemptAt: { lt: Date } },
              ];
            },
            { OR: [{ syncClaimedAt: null }, { syncClaimedAt: { lt: Date } }] },
          ];
        };
      }>(prisma.googleBusinessProfileConnection.findMany);
      expect(args.where.OR[0]).toEqual({ lastSyncedAt: null });
      expect(args.where.OR[1].lastSyncedAt.lt).toBeInstanceOf(Date);
      expect(
        Date.now() - args.where.OR[1].lastSyncedAt.lt.getTime(),
      ).toBeCloseTo(24 * 60 * 60 * 1000, -3);
      const backoff = args.where.AND[0].OR;
      expect(backoff[0]).toEqual({
        lastSyncStatus: { notIn: ['failed', 'partial'] },
      });
      expect(backoff[1].lastSyncAttemptAt.lt).toBeInstanceOf(Date);
      // A connection that failed or was partial within this window is
      // skipped this tick (avoiding an hourly hammer of a revoked token);
      // once its last attempt is older than the window, the same clause
      // makes it eligible again — recovery is automatic, not a separate
      // code path.
      expect(
        Date.now() - backoff[1].lastSyncAttemptAt.lt.getTime(),
      ).toBeCloseTo(6 * 60 * 60 * 1000, -3);
      const claimExclusion = args.where.AND[1].OR;
      expect(claimExclusion[0]).toEqual({ syncClaimedAt: null });
      expect(claimExclusion[1].syncClaimedAt.lt).toBeInstanceOf(Date);
      expect(
        Date.now() - claimExclusion[1].syncClaimedAt.lt.getTime(),
      ).toBeCloseTo(5 * 60 * 1000, -3);
    });

    // RC-40.1 fix — the starvation bug: ordering by lastSyncedAt alone (an
    // earlier version of this dispatcher) never advances for a connection
    // stuck in a failure loop, so it would keep sorting first forever and
    // crowd out a connection that has never even had a first attempt.
    it('never lets any number of failing connections starve out one that has never been attempted', async () => {
      // The database itself enforces the ordering; this test proves the
      // *contract* (lastSyncAttemptAt asc nulls first) rather than
      // simulating 50 rows against a mock — see the orderBy assertion
      // above for the exact clause. Here we assert the never-attempted
      // connection is queried for even though the `where` also matches
      // many recently-attempted, still-eligible-after-backoff connections
      // — i.e. it is never excluded by the where-clause construction.
      prisma.googleBusinessProfileConnection.findMany.mockResolvedValue([
        { id: 'never-tried', organizationId: 'org-never-tried' },
      ]);
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        id: 'never-tried',
        organizationId: 'org-never-tried',
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

      const [args] = callArgs<{ orderBy: unknown[] }>(
        prisma.googleBusinessProfileConnection.findMany,
      );
      // The never-attempted connection sorts via `nulls: 'first'` on
      // lastSyncAttemptAt — strictly ahead of any number of connections
      // that have a real (non-null) attempt timestamp, however recent.
      expect(args.orderBy[0]).toEqual({
        lastSyncAttemptAt: { sort: 'asc', nulls: 'first' },
      });
      expect(fetchSpy).toHaveBeenCalled();
    });

    it('backs off a connection whose last attempt was partial, not only failed', async () => {
      prisma.googleBusinessProfileConnection.findMany.mockResolvedValue([]);
      await service.refreshStaleLocations();
      const [args] = callArgs<{
        where: { AND: [{ OR: [{ lastSyncStatus: { notIn: string[] } }] }] };
      }>(prisma.googleBusinessProfileConnection.findMany);
      expect(args.where.AND[0].OR[0]).toEqual({
        lastSyncStatus: { notIn: ['failed', 'partial'] },
      });
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

    // RC-40.1 fix — a freshly-created connection must not be immediately
    // "stale": there has been no chance yet for the first sync to run.
    // Freshness for a never-synced connection is measured from connectedAt,
    // not from a null lastSyncedAt treated as infinitely old.
    it('does not report stale immediately after connecting, even though never synced yet', async () => {
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        googleAccountEmail: 'owner@example.com',
        connectedAt: new Date(Date.now() - 5 * 60 * 1000),
        lastSyncedAt: null,
        lastSyncAttemptAt: null,
        lastSyncStatus: 'never',
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(0);
      await expect(service.getStatus('org-1')).resolves.toMatchObject({
        connected: true,
        stale: false,
        expired: false,
      });
    });

    it('reports stale once a never-synced connection has been connected for more than 24h without a first success', async () => {
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        googleAccountEmail: 'owner@example.com',
        connectedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
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

      it('logs nothing but the heartbeat when there is nothing to purge', async () => {
        prisma.googleBusinessProfileLocation.deleteMany.mockResolvedValue({
          count: 0,
        });
        const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
        await service.purgeExpiredLocations();
        const calls = callArgs<Record<string, unknown>>(
          logSpy as unknown as jest.Mock,
        );
        expect(calls).toHaveLength(1);
        expect(calls[0].metric).toBe('gbp_location_retention');
        logSpy.mockRestore();
      });

      // RC-40.1 fix — an unconditional heartbeat: its own *absence* from the
      // logs (not any particular value) is what an alert watches for, since
      // a scheduler that has stopped running entirely would otherwise look
      // identical to one that simply has nothing to report.
      describe('gbp_location_retention heartbeat', () => {
        it('is emitted even when zero fiches exist — rowCount:0, maxAgeHours:null', async () => {
          prisma.googleBusinessProfileLocation.deleteMany.mockResolvedValue({
            count: 0,
          });
          prisma.googleBusinessProfileLocation.aggregate.mockResolvedValue({
            _count: 0,
            _min: { lastSyncedAt: null },
          });
          const logSpy = jest
            .spyOn(Logger.prototype, 'log')
            .mockImplementation();
          await service.purgeExpiredLocations();
          const metricCall = callArgs<Record<string, unknown>>(
            logSpy as unknown as jest.Mock,
          ).find((call) => call.metric === 'gbp_location_retention');
          expect(metricCall).toEqual({
            metric: 'gbp_location_retention',
            rowCount: 0,
            maxAgeHours: null,
            ceilingHours: 29 * 24,
          });
          logSpy.mockRestore();
        });

        it('reports the real row count and the oldest fiche age when fiches exist', async () => {
          prisma.googleBusinessProfileLocation.deleteMany.mockResolvedValue({
            count: 0,
          });
          prisma.googleBusinessProfileLocation.aggregate.mockResolvedValue({
            _count: 7,
            _min: {
              lastSyncedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
            },
          });
          const logSpy = jest
            .spyOn(Logger.prototype, 'log')
            .mockImplementation();
          await service.purgeExpiredLocations();
          const metricCall = callArgs<{
            metric: string;
            rowCount: number;
            maxAgeHours: number;
            ceilingHours: number;
          }>(logSpy as unknown as jest.Mock).find(
            (call) => call.metric === 'gbp_location_retention',
          );
          expect(metricCall).toBeDefined();
          expect(metricCall!.rowCount).toBe(7);
          expect(metricCall!.maxAgeHours).toBeCloseTo(10 * 24, 0);
          expect(metricCall!.ceilingHours).toBe(29 * 24);
          logSpy.mockRestore();
        });

        it('computes its values from the post-purge state — the aggregate is queried after the delete', async () => {
          prisma.googleBusinessProfileLocation.deleteMany.mockResolvedValue({
            count: 3,
          });
          prisma.googleBusinessProfileLocation.aggregate.mockResolvedValue({
            _count: 2,
            _min: { lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000) },
          });
          const callOrder: string[] = [];
          prisma.googleBusinessProfileLocation.deleteMany.mockImplementation(
            () => {
              callOrder.push('deleteMany');
              return Promise.resolve({ count: 3 });
            },
          );
          prisma.googleBusinessProfileLocation.aggregate.mockImplementation(
            () => {
              callOrder.push('aggregate');
              return Promise.resolve({
                _count: 2,
                _min: { lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000) },
              });
            },
          );
          await service.purgeExpiredLocations();
          expect(callOrder).toEqual(['deleteMany', 'aggregate']);
        });

        it('uses a single aggregate query for both row count and oldest age, never a separate count() and findFirst()', async () => {
          prisma.googleBusinessProfileLocation.deleteMany.mockResolvedValue({
            count: 0,
          });
          await service.purgeExpiredLocations();
          expect(
            prisma.googleBusinessProfileLocation.aggregate,
          ).toHaveBeenCalledTimes(1);
          expect(
            prisma.googleBusinessProfileLocation.count,
          ).not.toHaveBeenCalled();
          expect(
            prisma.googleBusinessProfileLocation.findFirst,
          ).not.toHaveBeenCalled();
        });
      });
    });

    // RC-40.1 fix — operational hardening: the hourly cron leaves up to a
    // ~1h (or, under a prolonged outage, much longer) window where an
    // already-expired fiche sits unpurged in the database (never served —
    // every read path filters independently — but not yet deleted). Running
    // the purge once at boot closes that window immediately after a
    // deploy/restart rather than waiting for the next tick.
    describe('onModuleInit (startup purge)', () => {
      it('runs the expiry purge once at startup', async () => {
        const purgeSpy = jest
          .spyOn(service, 'purgeExpiredLocations')
          .mockResolvedValue(undefined);
        await service.onModuleInit();
        expect(purgeSpy).toHaveBeenCalledTimes(1);
      });

      it('never lets a startup purge failure block module initialization', async () => {
        jest
          .spyOn(service, 'purgeExpiredLocations')
          .mockRejectedValue(new Error('DB not ready yet'));
        await expect(service.onModuleInit()).resolves.toBeUndefined();
      });
    });
  });

  // RC-40.1 fix — Command Center consumes this signal directly, so expired
  // and stale must never resolve to a silent 'ok', and a zero-location
  // connector after expiration must never be presented as healthy.
  describe('getIntelligenceSignal (Command Center)', () => {
    function mockConnection(
      overrides: Partial<{
        lastSyncedAt: Date | null;
        lastSyncAttemptAt: Date | null;
        lastSyncStatus: string;
        connectedAt: Date;
      }>,
    ) {
      prisma.googleBusinessProfileConnection.findUnique.mockResolvedValue({
        googleAccountEmail: 'owner@example.com',
        connectedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        lastSyncedAt: null,
        lastSyncAttemptAt: null,
        lastSyncStatus: 'never',
        ...overrides,
      });
    }

    it('reports ok only when connected, synced, successful, not stale and not expired', async () => {
      mockConnection({
        lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000),
        lastSyncAttemptAt: new Date(),
        lastSyncStatus: 'success',
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(3);
      await expect(
        service.getIntelligenceSignal('org-1'),
      ).resolves.toMatchObject({
        status: 'ok',
        data: { locationCount: 3, expired: false, stale: false },
      });
    });

    it('never reports ok when expired — degrades to partial with expired:true, even if the last attempt succeeded', async () => {
      mockConnection({
        lastSyncedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        lastSyncAttemptAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        lastSyncStatus: 'success',
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(0);
      await expect(
        service.getIntelligenceSignal('org-1'),
      ).resolves.toMatchObject({
        status: 'partial',
        data: { locationCount: 0, expired: true },
      });
    });

    it('never silently reports ok when stale, even if lastSyncStatus is success', async () => {
      mockConnection({
        lastSyncedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
        lastSyncAttemptAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
        lastSyncStatus: 'success',
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(2);
      await expect(
        service.getIntelligenceSignal('org-1'),
      ).resolves.toMatchObject({
        status: 'partial',
        data: { locationCount: 2, stale: true, expired: false },
      });
    });

    it('never presents an expired, zero-location connector as a healthy connector', async () => {
      mockConnection({
        lastSyncedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        lastSyncAttemptAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        lastSyncStatus: 'failed',
      });
      prisma.googleBusinessProfileLocation.count.mockResolvedValue(0);
      const signal = await service.getIntelligenceSignal('org-1');
      expect(signal.status).not.toBe('ok');
      expect(signal.data).toMatchObject({ locationCount: 0, expired: true });
    });
  });

  // RC-40.1 fix — findOwnedLocation() now filters by the absolute expiry
  // ceiling, so an expired fiche is exactly as unreachable through every
  // identifier-based route as it already was through
  // listLocations()/getStatus(), and no Google call can ever be made for
  // one (every route below resolves the location before any Google
  // request).
  describe('absolute expiry blocks every identifier-based route', () => {
    it('findOwnedLocation queries with the absolute ceiling', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(null);
      await expect(
        service.listReviews('org-1', 'expired-loc'),
      ).rejects.toBeInstanceOf(NotFoundException);
      const [args] = callArgs<{ where: { lastSyncedAt: { gt: Date } } }>(
        prisma.googleBusinessProfileLocation.findFirst,
      );
      expect(args.where.lastSyncedAt.gt).toBeInstanceOf(Date);
      expect(Date.now() - args.where.lastSyncedAt.gt.getTime()).toBeCloseTo(
        29 * 24 * 60 * 60 * 1000,
        -3,
      );
    });

    it('linkLocation cannot link an expired fiche', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(null);
      prisma.location.findFirst.mockResolvedValue({ id: 'robia-1' });
      await expect(
        service.linkLocation('org-1', 'expired-loc', 'robia-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        prisma.googleBusinessProfileLocation.update,
      ).not.toHaveBeenCalled();
    });

    it('linkLocation returns 404 for a fiche that simply does not exist', async () => {
      // Same query shape as the expired case above — findOwnedLocation()'s
      // WHERE clause returns no row either way, and that ambiguity is
      // intentional: from the caller's perspective, an expired fiche must
      // be exactly as unreachable as one that was never there.
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(null);
      prisma.location.findFirst.mockResolvedValue({ id: 'robia-1' });
      await expect(
        service.linkLocation('org-1', 'never-existed', 'robia-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        prisma.googleBusinessProfileLocation.update,
      ).not.toHaveBeenCalled();
    });

    // RC-40.1 fix — `.catch(() => null)` used to swallow every rejection
    // from findOwnedLocation(), including a genuine internal failure, and
    // reinterpret it as a plain 404. Only a NotFoundException may collapse
    // into "not found"; anything else (a Prisma error, a timeout) must
    // surface as-is.
    it('linkLocation propagates an internal error instead of masking it as a 404', async () => {
      const dbError = new Error('Connection terminated unexpectedly');
      prisma.googleBusinessProfileLocation.findFirst.mockRejectedValue(dbError);
      prisma.location.findFirst.mockResolvedValue({ id: 'robia-1' });
      await expect(
        service.linkLocation('org-1', 'loc-1', 'robia-1'),
      ).rejects.toBe(dbError);
      expect(
        prisma.googleBusinessProfileLocation.update,
      ).not.toHaveBeenCalled();
    });

    it('unlinkLocation cannot unlink an expired fiche', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(null);
      await expect(
        service.unlinkLocation('org-1', 'expired-loc'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        prisma.googleBusinessProfileLocation.update,
      ).not.toHaveBeenCalled();
    });

    it('listReviews cannot list reviews for an expired fiche', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(null);
      await expect(
        service.listReviews('org-1', 'expired-loc'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        prisma.googleBusinessProfileReview.findMany,
      ).not.toHaveBeenCalled();
    });

    it('syncReviews cannot sync an expired fiche, and never calls Google', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(null);
      const fetchSpy = jest.spyOn(global, 'fetch');
      await expect(
        service.syncReviews('org-1', 'expired-loc'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        prisma.googleBusinessProfileLocation.updateMany,
      ).not.toHaveBeenCalled();
    });

    it('getPerformanceMetrics cannot read performance for an expired fiche, and never calls Google', async () => {
      prisma.googleBusinessProfileLocation.findFirst.mockResolvedValue(null);
      const fetchSpy = jest.spyOn(global, 'fetch');
      await expect(
        service.getPerformanceMetrics('org-1', 'expired-loc'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        prisma.googleBusinessProfileLocation.updateMany,
      ).not.toHaveBeenCalled();
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
