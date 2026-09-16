import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

function fakeDelivery(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'delivery-1',
    channel: 'email',
    templateKey: 'audit_completed',
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: new Date('2026-09-21T06:00:00.000Z'),
    providerMessageId: null,
    lastError: null,
    sentAt: null,
    createdAt: new Date('2026-09-21T05:00:00.000Z'),
    updatedAt: new Date('2026-09-21T05:00:00.000Z'),
    recipient: { email: 'jane@example.com' },
    ...overrides,
  };
}

describe('NotificationsController', () => {
  const req = {
    user: { userId: 'user-1', email: 'jane@example.com' },
    organizationId: 'org-1',
  } as unknown as Request & {
    user: { userId: string; email: string };
    organizationId: string;
  };

  let notifications: {
    findAllForOrganization: jest.Mock;
    findOne: jest.Mock;
    retry: jest.Mock;
  };
  let controller: NotificationsController;

  beforeEach(() => {
    notifications = {
      findAllForOrganization: jest.fn().mockResolvedValue([fakeDelivery()]),
      findOne: jest.fn().mockResolvedValue(fakeDelivery()),
      retry: jest.fn().mockResolvedValue(fakeDelivery({ status: 'pending' })),
    };
    controller = new NotificationsController(
      notifications as unknown as NotificationsService,
    );
  });

  it('lists deliveries scoped to the request organization, masking the recipient', async () => {
    const result = await controller.findAll(req);
    expect(notifications.findAllForOrganization).toHaveBeenCalledWith('org-1');
    expect(result).toEqual([
      expect.objectContaining({
        id: 'delivery-1',
        recipientMasked: 'j***@example.com',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
  });

  it('fetches a single delivery scoped to the request organization', async () => {
    const result = await controller.findOne(req, 'delivery-1');
    expect(notifications.findOne).toHaveBeenCalledWith('org-1', 'delivery-1');
    expect(result.recipientMasked).toBe('j***@example.com');
  });

  it('retries a delivery scoped to the request organization and returns its refreshed state', async () => {
    const result = await controller.retry(req, 'delivery-1');
    expect(notifications.retry).toHaveBeenCalledWith('org-1', 'delivery-1');
    expect(notifications.findOne).toHaveBeenCalledWith('org-1', 'delivery-1');
    expect(result.status).toBe('pending');
  });

  it('never exposes SMTP configuration or transport internals in any response', async () => {
    const result = await controller.findOne(req, 'delivery-1');
    expect(Object.keys(result)).not.toContain('smtpPassword');
    expect(JSON.stringify(result)).not.toMatch(/smtp|password/i);
  });
});
