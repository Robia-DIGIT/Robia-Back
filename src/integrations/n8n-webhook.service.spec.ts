import { Logger } from '@nestjs/common';
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
    global.fetch = fetchMock;
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
      name === 'N8N_WEBHOOK_BASE_URL' ? '': (values[name] ?? fallback ?? ''),
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

  describe('external-call metric', () => {
    let logSpy: jest.SpyInstance;

    function findMetricCall(
      spy: jest.SpyInstance,
    ): Record<string, unknown> | undefined {
      const calls = spy.mock.calls as unknown[][];
      for (const call of calls) {
        const [arg] = call;
        if (
          arg !== null &&
          typeof arg === 'object' &&
          (arg as Record<string, unknown>).metric === 'external_call'
        ) {
          return arg as Record<string, unknown>;
        }
      }
      return undefined;
    }

    beforeEach(() => {
      logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    it('logs a success metric with provider, operation, and duration', async () => {
      await service.notifyProspectCreated({
        name: 'Prospect',
        email: 'prospect@example.com',
        message: 'Je souhaite une démonstration.',
      });

      const metric = findMetricCall(logSpy);
      expect(metric).toBeDefined();
      expect(metric?.provider).toBe('n8n');
      expect(metric?.operation).toBe('robia-prospect-created');
      expect(metric?.success).toBe(true);
      expect(metric?.reason).toBeNull();
      expect(typeof metric?.durationMs).toBe('number');
    });

    it('logs a failure metric with the http status as reason when n8n refuses the request', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401 });

      await service.notifyProspectCreated({
        name: 'Prospect',
        email: 'prospect@example.com',
        message: 'Je souhaite une démonstration.',
      });

      const metric = findMetricCall(logSpy);
      expect(metric?.success).toBe(false);
      expect(metric?.reason).toBe('http_401');
    });

    it('logs a failure metric with a network_error reason when the request throws', async () => {
      fetchMock.mockRejectedValue(new Error('connection reset'));

      await service.notifyProspectCreated({
        name: 'Prospect',
        email: 'prospect@example.com',
        message: 'Je souhaite une démonstration.',
      });

      const metric = findMetricCall(logSpy);
      expect(metric?.success).toBe(false);
      expect(metric?.reason).toBe('network_error');
    });

    it('does not log a metric when the webhook is not attempted at all', async () => {
      config.get.mockImplementation((name: string, fallback?: string) =>
        name === 'N8N_WEBHOOK_BASE_URL'
          ? undefined
          : (values[name] ?? fallback),
      );
      service = new N8nWebhookService(config as unknown as ConfigService);

      await service.notifyProspectCreated({
        name: 'Prospect',
        email: 'prospect@example.com',
        message: 'Je souhaite une démonstration.',
      });

      expect(findMetricCall(logSpy)).toBeUndefined();
    });
  });
});
