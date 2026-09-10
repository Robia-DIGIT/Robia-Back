import type { Request, Response } from 'express';
import { GoogleSearchConsoleController } from './google-search-console.controller';
import { GoogleSearchConsoleService } from './google-search-console.service';

describe('GoogleSearchConsoleController', () => {
  const state = 'signed-state.value';
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}`;
  const service = {
    getAuthorizationUrl: jest.fn(() => authorizationUrl),
    completeAuthorization: jest.fn(),
    getDashboardRedirect: jest.fn(
      (status: string) =>
        `https://app.robiacopilot.site/google-data?google=${status}`,
    ),
  };
  let controller: GoogleSearchConsoleController;
  let response: Pick<Response, 'cookie' | 'clearCookie' | 'redirect'>;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new GoogleSearchConsoleController(
      service as unknown as GoogleSearchConsoleService,
    );
    response = {
      cookie: jest.fn(),
      clearCookie: jest.fn(),
      redirect: jest.fn(),
    };
  });

  it('binds the signed state to a secure, short-lived browser cookie', () => {
    const request = {
      organizationId: 'org-1',
      user: { userId: 'user-1', email: 'owner@example.com' },
    };

    expect(
      controller.authorize(request as never, response as Response),
    ).toEqual({ url: authorizationUrl });
    expect(response.cookie).toHaveBeenCalledWith(
      'robia_google_oauth_state',
      state,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 600000,
      }),
    );
  });

  it('rejects a callback that did not originate in the same browser', async () => {
    const request = { headers: { cookie: 'robia_google_oauth_state=other' } };

    await controller.callback(
      'code',
      state,
      undefined,
      request as Request,
      response as Response,
    );

    expect(service.completeAuthorization).not.toHaveBeenCalled();
    expect(response.redirect).toHaveBeenCalledWith(
      'https://app.robiacopilot.site/google-data?google=error',
    );
  });

  it('completes a callback with matching query and cookie states', async () => {
    const request = {
      headers: {
        cookie: `robia_google_oauth_state=${encodeURIComponent(state)}`,
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

    expect(service.completeAuthorization).toHaveBeenCalledWith('code', state);
    expect(response.redirect).toHaveBeenCalledWith(
      'https://app.robiacopilot.site/google-data?google=connected',
    );
  });
});
