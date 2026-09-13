import { ConfigService } from '@nestjs/config';
import { N8nWebhookService } from './n8n-webhook.service';

describe('N8nWebhookService', () => {
  const values: Record<string, string> = {
    N8N_WEBHOOK_BASE_URL: 'https://n8n.robiacopilot.site/webhook',
    N8N_WEBHOOK_SECRET: 'a'.repeat(64),
    DASHBOARD_URL: 'https://app.robiacopilot.site',
  };
  const config = {
    get: jest.fn((name: string, fallback?: string) => values[name] ?? fallback),
  };
  let service: N8nWebhookService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockImplementation(
      (name: string, fallback?: string) => values[name] ?? fallback,
    );
    service = new N8nWebhookService(config as unknown as ConfigService);
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sends the welcome event with the configured shared secret', async () => {
    await expect(
      service.notifyUserRegistered({
        email: 'landry@example.com',
        name: 'Landry',
        organizationName: 'ROBIA',
      }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://n8n.robiacopilot.site/webhook/robia-user-registered'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Robia-Webhook-Secret': 'a'.repeat(64),
        }),
      }),
    );
    const request = fetchMock.mock.calls[0][1];
    expect(JSON.parse(request.body)).toEqual(
      expect.objectContaining({
        email: 'landry@example.com',
        dashboardUrl: 'https://app.robiacopilot.site/login',
      }),
    );
  });

  it('returns false without making a request when configuration is absent', async () => {
    config.get.mockImplementation((name: string, fallback?: string) =>
      name === 'N8N_WEBHOOK_BASE_URL' ? undefined : (values[name] ?? fallback),
    );
    service = new N8nWebhookService(config as unknown as ConfigService);

    await expect(
      service.notifyProspectCreated({
        name: 'Prospect',
        email: 'prospect@example.com',
        message: 'Je souhaite une démonstration.',
      }),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not expose response contents when n8n refuses a request', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    await expect(
      service.notifyProspectCreated({
        name: 'Prospect',
        email: 'prospect@example.com',
        message: 'Je souhaite une démonstration.',
      }),
    ).resolves.toBe(false);
  });
});
