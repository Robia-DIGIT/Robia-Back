import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingService } from './billing.service';

describe('BillingService', () => {
  const stripeSubscription = {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  };
  const prisma = { stripeSubscription } as any;
  const values: Record<string, string> = {
    STRIPE_SECRET_KEY: 'sk_test_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    STRIPE_PRICE_PRO_MONTHLY: 'price_monthly',
    STRIPE_PRICE_PRO_ANNUAL: 'price_annual',
    STRIPE_TRIAL_DAYS: '14',
    APP_URL: 'https://app.robiacopilot.site',
  };
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;

  beforeEach(() => jest.clearAllMocks());

  it('returns the Starter plan when no Stripe record exists', async () => {
    stripeSubscription.findUnique.mockResolvedValue(null);
    const service = new BillingService(prisma, config);

    await expect(service.getSubscription('org-1')).resolves.toEqual({
      plan: 'starter',
      status: 'inactive',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canManage: false,
    });
  });

  it('prevents a second active subscription', async () => {
    stripeSubscription.findUnique.mockResolvedValue({ status: 'active' });
    const service = new BillingService(prisma, config);

    await expect(
      service.createCheckoutSession('org-1', 'owner@example.com', 'monthly'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a hosted monthly Checkout session with a 14-day trial', async () => {
    stripeSubscription.findUnique.mockResolvedValue(null);
    const create = jest
      .fn()
      .mockResolvedValue({ url: 'https://checkout.test' });
    const service = new BillingService(prisma, config);
    (service as any).stripeClient = { checkout: { sessions: { create } } };

    await expect(
      service.createCheckoutSession('org-1', 'owner@example.com', 'monthly'),
    ).resolves.toEqual({ url: 'https://checkout.test' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer_email: 'owner@example.com',
        line_items: [{ price: 'price_monthly', quantity: 1 }],
        subscription_data: expect.objectContaining({ trial_period_days: 14 }),
      }),
    );
  });

  it('rejects a webhook with an invalid signature', async () => {
    const service = new BillingService(prisma, config);
    (service as any).stripeClient = {
      webhooks: {
        constructEvent: jest.fn(() => {
          throw new Error('invalid');
        }),
      },
    };

    await expect(
      service.handleWebhook(Buffer.from('{}'), 'bad-signature'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
