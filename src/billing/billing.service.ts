import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';

type BillingPeriod = 'monthly' | 'annual';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private stripeClient?: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getSubscription(organizationId: string) {
    const subscription = await this.prisma.stripeSubscription.findUnique({
      where: { organizationId },
    });
    const hasPaidAccess = Boolean(
      subscription &&
      ['active', 'trialing', 'past_due'].includes(subscription.status),
    );

    return {
      plan: hasPaidAccess ? (subscription?.plan ?? 'pro') : 'starter',
      status: subscription?.status ?? 'inactive',
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      canManage: Boolean(subscription?.stripeCustomerId),
    };
  }

  async createCheckoutSession(
    organizationId: string,
    email: string,
    billingPeriod: BillingPeriod,
  ) {
    const billing = await this.prisma.stripeSubscription.findUnique({
      where: { organizationId },
    });
    if (
      billing &&
      ['active', 'trialing', 'past_due', 'incomplete'].includes(billing.status)
    ) {
      throw new ConflictException(
        'Un abonnement existe déjà. Utilisez le portail de facturation pour le gérer.',
      );
    }

    const priceId = this.priceId(billingPeriod);
    const appUrl = this.appUrl();
    const session = await this.stripe().checkout.sessions.create({
      mode: 'subscription',
      integration_identifier: 'robia_web_kqtmzjha',
      client_reference_id: organizationId,
      customer: billing?.stripeCustomerId ?? undefined,
      customer_email: billing?.stripeCustomerId ? undefined : email,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${appUrl}/billing?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/billing?billing=cancelled`,
      metadata: { organizationId, plan: 'pro', billingPeriod },
      subscription_data: {
        trial_period_days: this.trialDays(),
        metadata: { organizationId, plan: 'pro', billingPeriod },
      },
    });

    if (!session.url) {
      throw new ServiceUnavailableException(
        "Stripe n'a pas retourné d'URL de paiement.",
      );
    }
    return { url: session.url };
  }

  async createPortalSession(organizationId: string) {
    const billing = await this.prisma.stripeSubscription.findUnique({
      where: { organizationId },
    });
    if (!billing?.stripeCustomerId) {
      throw new BadRequestException(
        "Aucun compte de facturation n'est encore associé à cette organisation.",
      );
    }

    const session = await this.stripe().billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: `${this.appUrl()}/billing`,
    });
    return { url: session.url };
  }

  async handleWebhook(rawBody?: Buffer, signature?: string) {
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret || !rawBody || !signature) {
      throw new BadRequestException('Webhook Stripe incomplet.');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe().webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch {
      throw new BadRequestException('Signature webhook Stripe invalide.');
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.syncSubscription(event.data.object);
        break;
      default:
        this.logger.debug(`Événement Stripe ignoré : ${event.type}`);
    }

    return { received: true };
  }

  private async handleCheckoutCompleted(session: Stripe.Checkout.Session) {
    const organizationId =
      session.metadata?.organizationId ?? session.client_reference_id;
    const customerId = this.idOf(session.customer);
    const subscriptionId = this.idOf(session.subscription);
    if (!organizationId || !customerId) return;

    await this.prisma.stripeSubscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        plan: 'pro',
        status: 'pending',
      },
      update: {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        plan: 'pro',
      },
    });
  }

  private async syncSubscription(subscription: Stripe.Subscription) {
    const organizationId = subscription.metadata?.organizationId;
    if (!organizationId) {
      this.logger.warn(
        `Abonnement Stripe ${subscription.id} sans organizationId`,
      );
      return;
    }

    const item = subscription.items.data[0];
    await this.prisma.stripeSubscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        stripeCustomerId: this.idOf(subscription.customer),
        stripeSubscriptionId: subscription.id,
        stripePriceId: item?.price.id,
        plan: 'pro',
        status: subscription.status,
        currentPeriodEnd: item?.current_period_end
          ? new Date(item.current_period_end * 1000)
          : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
      update: {
        stripeCustomerId: this.idOf(subscription.customer),
        stripeSubscriptionId: subscription.id,
        stripePriceId: item?.price.id,
        plan: 'pro',
        status: subscription.status,
        currentPeriodEnd: item?.current_period_end
          ? new Date(item.current_period_end * 1000)
          : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
    });
  }

  private stripe() {
    const key = this.config.get<string>('STRIPE_API_KEY');
    if (!key) {
      throw new ServiceUnavailableException(
        "La facturation Stripe n'est pas encore configurée.",
      );
    }
    this.stripeClient ??= new Stripe(key);
    return this.stripeClient;
  }

  private priceId(period: BillingPeriod) {
    const key =
      period === 'annual'
        ? 'STRIPE_PRICE_PRO_ANNUAL'
        : 'STRIPE_PRICE_PRO_MONTHLY';
    const priceId = this.config.get<string>(key);
    if (!priceId) {
      throw new ServiceUnavailableException(`Tarif Stripe absent : ${key}.`);
    }
    return priceId;
  }

  private appUrl() {
    return (
      this.config.get<string>('APP_URL') ??
      this.config.get<string>('FRONTEND_URL') ??
      'https://app.robiacopilot.site'
    ).replace(/\/$/, '');
  }

  private trialDays() {
    const value = Number(this.config.get<string>('STRIPE_TRIAL_DAYS') ?? '14');
    return Number.isInteger(value) && value >= 1 && value <= 730 ? value : 14;
  }

  private idOf(value: string | { id: string } | null): string | null {
    if (!value) return null;
    return typeof value === 'string' ? value : value.id;
  }
}
