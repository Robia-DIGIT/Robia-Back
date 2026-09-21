import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleBusinessProfileController } from './google-business-profile.controller';
import { GoogleBusinessProfileService } from './google-business-profile.service';

describe('GoogleBusinessProfileController OAuth boundary', () => {
  const state = 'signed-state.value';
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}`;
  const service = {
    getAuthorizationUrl: jest.fn(() => authorizationUrl),
    completeAuthorization: jest.fn(),
    getDashboardRedirect: jest.fn(
      (status: string) =>
        `https://app.robiacopilot.site/business-profile?gbp=${status}`,
    ),
  };
  let controller: GoogleBusinessProfileController;
  let response: Pick<Response, 'cookie' | 'clearCookie' | 'redirect'>;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new GoogleBusinessProfileController(
      service as unknown as GoogleBusinessProfileService,
    );
    response = {
      cookie: jest.fn(),
      clearCookie: jest.fn(),
      redirect: jest.fn(),
    };
  });

  it('binds authorization state to a secure callback-only cookie', () => {
    const request = {
      organizationId: 'org-1',
      user: { userId: 'user-1', email: 'owner@example.com' },
    };

    expect(
      controller.authorize(request as never, response as Response),
    ).toEqual({
      url: authorizationUrl,
    });
    expect(response.cookie).toHaveBeenCalledWith(
      'robia_gbp_oauth_state',
      state,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 600000,
        path: '/integrations/google/business-profile/callback',
      }),
    );
  });

  it('rejects a callback from a browser without the matching state cookie', async () => {
    const request = { headers: { cookie: 'robia_gbp_oauth_state=other' } };

    await controller.callback(
      'code',
      state,
      undefined,
      request as Request,
      response as Response,
    );

    expect(service.completeAuthorization).not.toHaveBeenCalled();
    expect(response.redirect).toHaveBeenCalledWith(
      'https://app.robiacopilot.site/business-profile?gbp=error',
    );
  });

  it('clears the state cookie and completes a matching callback', async () => {
    const request = {
      headers: {
        cookie: `robia_gbp_oauth_state=${encodeURIComponent(state)}`,
      },
    };
    service.completeAuthorization.mockResolvedValue({ connected: true });

    await controller.callback(
      'code',
      state,
      undefined,
      request as Request,
      response as Response,
    );

    expect(response.clearCookie).toHaveBeenCalled();
    expect(service.completeAuthorization).toHaveBeenCalledWith('code', state);
    expect(response.redirect).toHaveBeenCalledWith(
      'https://app.robiacopilot.site/business-profile?gbp=connected',
    );
  });
});

describe('Google Business Profile read-only lifecycle integration', () => {
  it('covers authorize, state cookie, callback, sync, link, reconnect and disconnect', async () => {
    let connection: Record<string, unknown> | null = null;
    let linkedLocationId: string | null = null;
    const mirrors: Array<Record<string, unknown>> = [];
    const connectionDelegate = {
      findUnique: jest.fn(() => Promise.resolve(connection)),
      upsert: jest.fn(
        (args: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          connection = {
            id: 'conn-1',
            organizationId: 'org-1',
            connectedAt: new Date(),
            lastSyncedAt: null,
            lastSyncAttemptAt: null,
            lastSyncStatus: 'never',
            ...(connection ?? {}),
            ...(connection ? args.update : args.create),
          };
          return Promise.resolve(connection);
        },
      ),
      updateMany: jest.fn((args: { data: Record<string, unknown> }) => {
        connection = { ...(connection ?? {}), ...args.data };
        return Promise.resolve({ count: 1 });
      }),
      delete: jest.fn(() => {
        connection = null;
        mirrors.splice(0);
        return Promise.resolve({});
      }),
    };
    const mirrorDelegate = {
      findMany: jest.fn(() => Promise.resolve(mirrors)),
      findFirst: jest.fn(() => Promise.resolve(mirrors[0] ?? null)),
      upsert: jest.fn(
        (args: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = mirrors.find(
            (item) =>
              item.googleLocationName === args.create.googleLocationName,
          );
          if (existing) Object.assign(existing, args.update);
          else mirrors.push({ id: 'gbp-1', ...args.create });
          return Promise.resolve(existing ?? mirrors[mirrors.length - 1]);
        },
      ),
      update: jest.fn((args: { data: { robiaLocationId: string | null } }) => {
        linkedLocationId = args.data.robiaLocationId;
        return Promise.resolve({
          ...mirrors[0],
          robiaLocationId: linkedLocationId,
        });
      }),
      deleteMany: jest.fn(
        (args: { where: { googleLocationName?: { notIn: string[] } } }) => {
          const keep = args.where.googleLocationName?.notIn;
          if (keep) {
            const retained = mirrors.filter((item) =>
              keep.includes(String(item.googleLocationName)),
            );
            mirrors.splice(0, mirrors.length, ...retained);
          } else {
            mirrors.splice(0);
          }
          return Promise.resolve({ count: 0 });
        },
      ),
      count: jest.fn(() => Promise.resolve(mirrors.length)),
    };
    const prisma = {
      organization: {
        findFirst: jest.fn().mockResolvedValue({ id: 'org-1' }),
      },
      location: {
        findFirst: jest.fn().mockResolvedValue({ id: 'robia-location-1' }),
      },
      googleBusinessProfileConnection: connectionDelegate,
      googleBusinessProfileLocation: mirrorDelegate,
      $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
        callback(prisma),
      ),
    };
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      GOOGLE_BUSINESS_PROFILE_REDIRECT_URI:
        'https://api.robiacopilot.site/integrations/google/business-profile/callback',
      GOOGLE_TOKEN_ENCRYPTION_KEY: '11'.repeat(32),
      GOOGLE_OAUTH_STATE_SECRET: '22'.repeat(32),
      DASHBOARD_URL: 'https://app.robiacopilot.site',
    };
    const realService = new GoogleBusinessProfileService(
      prisma as PrismaService,
      {
        get: jest.fn(
          (name: string, fallback?: string) => env[name] ?? fallback,
        ),
      } as unknown as ConfigService,
    );
    const controller = new GoogleBusinessProfileController(realService);
    let cookieState = '';
    const authorizeResponse = {
      cookie: jest.fn((_name: string, value: string) => {
        cookieState = value;
      }),
    } as unknown as Response;

    const { url } = controller.authorize(
      {
        organizationId: 'org-1',
        user: { userId: 'user-1', email: 'owner@example.com' },
      } as never,
      authorizeResponse,
    );
    expect(new URL(url).searchParams.get('state')).toBe(cookieState);

    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'oauth-access-1',
            refresh_token: 'refresh-1',
            scope:
              'openid email https://www.googleapis.com/auth/business.manage',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sub: 'subject-1', email: 'owner@example.com' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'sync-access' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accounts: [{ name: 'accounts/1' }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            locations: [{ name: 'locations/1', title: 'ROBIA Google' }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'oauth-access-2',
            refresh_token: 'refresh-2',
            scope:
              'openid email https://www.googleapis.com/auth/business.manage',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sub: 'subject-1', email: 'owner@example.com' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    const redirect = jest.fn();
    const callbackResponse = {
      clearCookie: jest.fn(),
      redirect,
    } as unknown as Response;
    await controller.callback(
      'code-1',
      cookieState,
      undefined,
      {
        headers: { cookie: `robia_gbp_oauth_state=${cookieState}` },
      } as Request,
      callbackResponse,
    );
    expect(redirect).toHaveBeenCalledWith(
      'https://app.robiacopilot.site/business-profile?gbp=connected',
    );

    await expect(realService.syncLocations('org-1')).resolves.toMatchObject({
      synced: true,
      locationCount: 1,
    });
    await realService.linkLocation('org-1', 'gbp-1', 'robia-location-1');
    expect(linkedLocationId).toBe('robia-location-1');

    const reconnectState = new URL(
      realService.getAuthorizationUrl('org-1', 'user-1'),
    ).searchParams.get('state')!;
    await realService.completeAuthorization('code-2', reconnectState);
    expect(connection).toMatchObject({ googleAccountSubject: 'subject-1' });
    expect(mirrors).toHaveLength(1);

    await expect(realService.disconnect('org-1')).resolves.toEqual({
      disconnected: true,
      revokedByGoogle: true,
    });
    expect(connection).toBeNull();
  });
});
