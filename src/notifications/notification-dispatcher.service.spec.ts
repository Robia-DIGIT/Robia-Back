import { NotificationDispatcherService } from './notification-dispatcher.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  IncompleteSmtpConfigurationError,
  NotificationTransport,
  NotificationsDisabledError,
  PermanentNotificationDeliveryError,
  TemporaryNotificationDeliveryError,
} from './notification-transport';

interface FakeDeliveryRecord {
  id: string;
  organizationId: string;
  recipientUserId: string;
  channel: string;
  templateKey: string;
  templateData: Record<string, unknown>;
  status: string;
  idempotencyKey: string;
  attemptCount: number;
  nextAttemptAt: Date;
  claimedAt: Date | null;
  providerMessageId: string | null;
  lastError: string | null;
  sentAt: Date | null;
}

type ClaimedAtClause = { claimedAt: null } | { claimedAt: { lt: Date } };

function matchesClaimedAtClause(
  record: FakeDeliveryRecord,
  clause: ClaimedAtClause,
): boolean {
  if (clause.claimedAt === null) {
    return record.claimedAt === null;
  }
  return (
    record.claimedAt !== null &&
    record.claimedAt.getTime() < clause.claimedAt.lt.getTime()
  );
}

// Purpose-built, scoped to exactly the Prisma calls
// NotificationDispatcherService makes: notificationDelivery.findMany() (the
// due-set scan), .updateMany() (the atomic claim/finalize), .findUnique()
// (the post-claim re-fetch), and user.findUnique() (recipient lookup).
// Same synchronous find-then-mutate shape as RC-25's FakeSchedulerPrisma —
// no `await` inside the critical section — so a real concurrency test is
// possible.
class FakeDispatcherPrisma {
  private records: Map<string, FakeDeliveryRecord>;
  users: Map<string, { id: string; email: string }>;

  constructor(
    records: FakeDeliveryRecord[],
    users: { id: string; email: string }[] = [],
  ) {
    this.records = new Map(records.map((r) => [r.id, { ...r }]));
    this.users = new Map(users.map((u) => [u.id, { ...u }]));
  }

  get(id: string): FakeDeliveryRecord | undefined {
    return this.records.get(id);
  }

  private matchesDueSet(
    record: FakeDeliveryRecord,
    now: Date,
    staleThreshold: Date,
  ): boolean {
    const statusMatches =
      (['pending', 'retry_scheduled'].includes(record.status) &&
        record.nextAttemptAt.getTime() <= now.getTime()) ||
      record.status === 'processing';
    const leaseFree =
      record.claimedAt === null ||
      record.claimedAt.getTime() < staleThreshold.getTime();
    return statusMatches && leaseFree;
  }

  notificationDelivery = {
    findMany: (): FakeDeliveryRecord[] => {
      // The dispatcher always calls findMany() with its own computed
      // due-set where clause; this fake just returns everything and lets
      // updateMany's own re-check (mirroring the real WHERE) be the actual
      // gate — findMany here is only ever used by the dispatcher for its
      // outer scan, so returning the full set and relying on updateMany's
      // CAS for correctness matches how a real unfiltered-enough query plus
      // a precise UPDATE...WHERE behaves.
      return Array.from(this.records.values()).map((r) => ({ ...r }));
    },
    updateMany: ({
      where,
      data,
    }: {
      where: {
        id: string;
        claimedAt?: Date | null;
        AND?: [
          {
            OR: [
              { status: { in: string[] }; nextAttemptAt: { lte: Date } },
              { status: string },
            ];
          },
          { OR: ClaimedAtClause[] },
        ];
      };
      data: Partial<FakeDeliveryRecord>;
    }): { count: number } => {
      const record = this.records.get(where.id);
      if (!record) return { count: 0 };

      if (where.claimedAt !== undefined) {
        const matches =
          where.claimedAt === null
            ? record.claimedAt === null
            : record.claimedAt !== null &&
              record.claimedAt.getTime() === where.claimedAt.getTime();
        if (!matches) return { count: 0 };
      }

      if (where.AND) {
        const [statusBranch, leaseBranch] = where.AND;
        const statusOk = statusBranch.OR.some((clause) => {
          if ('nextAttemptAt' in clause) {
            return (
              clause.status.in.includes(record.status) &&
              record.nextAttemptAt.getTime() <=
                clause.nextAttemptAt.lte.getTime()
            );
          }
          return record.status === clause.status;
        });
        const leaseOk = leaseBranch.OR.some((clause) =>
          matchesClaimedAtClause(record, clause),
        );
        if (!statusOk || !leaseOk) return { count: 0 };
      }

      Object.assign(record, data);
      return { count: 1 };
    },
    findUnique: ({
      where,
    }: {
      where: { id: string };
    }): FakeDeliveryRecord | null => {
      const record = this.records.get(where.id);
      return record ? { ...record } : null;
    },
  };

  user = {
    findUnique: ({
      where,
    }: {
      where: { id: string };
    }): { email: string } | null => {
      const user = this.users.get(where.id);
      return user ? { email: user.email } : null;
    },
  };
}

function delivery(
  overrides: Partial<FakeDeliveryRecord> = {},
): FakeDeliveryRecord {
  return {
    id: 'delivery-1',
    organizationId: 'org-1',
    recipientUserId: 'user-1',
    channel: 'email',
    templateKey: 'audit_completed',
    templateData: { websiteUrl: 'https://example.com', globalScore: 80 },
    status: 'pending',
    idempotencyKey: 'automation-step:step-1',
    attemptCount: 0,
    nextAttemptAt: new Date('2026-09-21T06:00:00.000Z'),
    claimedAt: null,
    providerMessageId: null,
    lastError: null,
    sentAt: null,
    ...overrides,
  };
}

const RECIPIENT = { id: 'user-1', email: 'jane@example.com' };

describe('NotificationDispatcherService', () => {
  let sendEmail: jest.Mock;
  let ensureReady: jest.Mock;
  let transport: NotificationTransport;

  beforeEach(() => {
    sendEmail = jest.fn().mockResolvedValue({ providerMessageId: 'msg-1' });
    ensureReady = jest.fn();
    transport = { ensureReady, sendEmail };
  });

  function buildDispatcher(records: FakeDeliveryRecord[]) {
    const prisma = new FakeDispatcherPrisma(records, [RECIPIENT]);
    const dispatcher = new NotificationDispatcherService(
      prisma as unknown as PrismaService,
      transport,
    );
    return { dispatcher, prisma };
  }

  const now = new Date('2026-09-21T06:05:00.000Z');

  it('never touches the network when NOTIFICATIONS_ENABLED is off', async () => {
    ensureReady.mockImplementation(() => {
      throw new NotificationsDisabledError();
    });
    const { dispatcher } = buildDispatcher([delivery()]);

    await dispatcher.runDueDeliveries(now);

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('skips the whole tick, claiming nothing, when enabled but misconfigured', async () => {
    ensureReady.mockImplementation(() => {
      throw new IncompleteSmtpConfigurationError(['SMTP_USER']);
    });
    const { dispatcher, prisma } = buildDispatcher([delivery()]);

    await dispatcher.runDueDeliveries(now);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.get('delivery-1')?.status).toBe('pending');
  });

  it('sends a due pending delivery and marks it sent with the provider message id', async () => {
    const { dispatcher, prisma } = buildDispatcher([delivery()]);

    await dispatcher.runDueDeliveries(now);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [sentParams] = sendEmail.mock.calls[0] as [
      { to: string; subject: string; text: string },
    ];
    expect(sentParams.to).toBe('jane@example.com');
    expect(sentParams.subject).toBe('Audit terminé pour https://example.com');
    expect(sentParams.text).toContain('80/100');
    const stored = prisma.get('delivery-1')!;
    expect(stored.status).toBe('sent');
    expect(stored.providerMessageId).toBe('msg-1');
    expect(stored.sentAt).toEqual(now);
    expect(stored.claimedAt).toBeNull();
  });

  it('never sends a delivery that is not yet due', async () => {
    const { dispatcher } = buildDispatcher([
      delivery({ nextAttemptAt: new Date('2026-09-21T07:00:00.000Z') }),
    ]);
    await dispatcher.runDueDeliveries(now);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('schedules a retry with the first backoff delay on a temporary failure', async () => {
    sendEmail.mockRejectedValue(
      new TemporaryNotificationDeliveryError('SMTP busy'),
    );
    const { dispatcher, prisma } = buildDispatcher([delivery()]);

    await dispatcher.runDueDeliveries(now);

    const stored = prisma.get('delivery-1')!;
    expect(stored.status).toBe('retry_scheduled');
    expect(stored.attemptCount).toBe(1);
    expect(stored.claimedAt).toBeNull();
    expect(stored.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000); // 1 min
    expect(stored.lastError).toContain('SMTP busy');
  });

  it('automatically retries after the scheduled backoff and succeeds on the second attempt', async () => {
    sendEmail.mockRejectedValueOnce(
      new TemporaryNotificationDeliveryError('SMTP busy'),
    );
    const { dispatcher, prisma } = buildDispatcher([delivery()]);

    await dispatcher.runDueDeliveries(now);
    const afterFirstAttempt = prisma.get('delivery-1')!;
    expect(afterFirstAttempt.status).toBe('retry_scheduled');
    expect(afterFirstAttempt.nextAttemptAt.getTime()).toBe(
      now.getTime() + 60_000,
    );

    // Before the scheduled retry time: must not be picked up yet.
    const tooSoon = new Date(now.getTime() + 30_000);
    await dispatcher.runDueDeliveries(tooSoon);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    sendEmail.mockResolvedValueOnce({ providerMessageId: 'msg-retry-1' });
    const dueTime = new Date(now.getTime() + 60_000);
    await dispatcher.runDueDeliveries(dueTime);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    const final = prisma.get('delivery-1')!;
    expect(final.status).toBe('sent');
    expect(final.providerMessageId).toBe('msg-retry-1');
    expect(final.attemptCount).toBe(1);
  });

  it('sends a delivery straight to dead_letter on a permanent failure', async () => {
    sendEmail.mockRejectedValue(
      new PermanentNotificationDeliveryError('Mailbox does not exist'),
    );
    const { dispatcher, prisma } = buildDispatcher([delivery()]);

    await dispatcher.runDueDeliveries(now);

    const stored = prisma.get('delivery-1')!;
    expect(stored.status).toBe('dead_letter');
    expect(stored.attemptCount).toBe(1);
  });

  it('dead-letters a delivery once it has exhausted the maximum of 5 attempts', async () => {
    sendEmail.mockRejectedValue(
      new TemporaryNotificationDeliveryError('SMTP busy'),
    );
    const { dispatcher, prisma } = buildDispatcher([
      delivery({ status: 'retry_scheduled', attemptCount: 4 }),
    ]);

    await dispatcher.runDueDeliveries(now);

    const stored = prisma.get('delivery-1')!;
    expect(stored.status).toBe('dead_letter');
    expect(stored.attemptCount).toBe(5);
  });

  it('never redacts the delivery out of existence but never stores the raw recipient address in lastError', async () => {
    sendEmail.mockRejectedValue(
      new TemporaryNotificationDeliveryError(
        'Failed to deliver to jane@example.com: mailbox busy',
      ),
    );
    const { dispatcher, prisma } = buildDispatcher([delivery()]);

    await dispatcher.runDueDeliveries(now);

    const stored = prisma.get('delivery-1')!;
    expect(stored.lastError).not.toContain('jane@example.com');
    expect(stored.lastError).toContain('[REDACTED]');
  });

  it('two concurrent dispatcher instances processing the same due delivery: only one sends', async () => {
    const prisma = new FakeDispatcherPrisma([delivery()], [RECIPIENT]);
    const instanceA = new NotificationDispatcherService(
      prisma as unknown as PrismaService,
      transport,
    );
    const instanceB = new NotificationDispatcherService(
      prisma as unknown as PrismaService,
      transport,
    );

    await Promise.all([
      instanceA.runDueDeliveries(now),
      instanceB.runDueDeliveries(now),
    ]);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(prisma.get('delivery-1')?.status).toBe('sent');
  });

  it('reclaims a delivery whose lease has gone stale after a crash mid-send, using an unchanged idempotencyKey', async () => {
    // Simulates a claim that never resolved (process crash between claim
    // and send): status is 'processing', but the lease is old.
    const staleClaim = new Date(now.getTime() - 6 * 60 * 1000); // 6 min ago
    const { dispatcher, prisma } = buildDispatcher([
      delivery({ status: 'processing', claimedAt: staleClaim }),
    ]);

    await dispatcher.runDueDeliveries(now);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const stored = prisma.get('delivery-1')!;
    expect(stored.status).toBe('sent');
    expect(stored.idempotencyKey).toBe('automation-step:step-1');
  });

  it('does not reclaim a delivery whose lease is still fresh', async () => {
    const freshClaim = new Date(now.getTime() - 60 * 1000); // 1 min ago
    const { dispatcher, prisma } = buildDispatcher([
      delivery({ status: 'processing', claimedAt: freshClaim }),
    ]);

    await dispatcher.runDueDeliveries(now);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.get('delivery-1')?.status).toBe('processing');
  });

  it('sends a dead-lettered delivery again once it has been manually reset to pending', async () => {
    const { dispatcher, prisma } = buildDispatcher([
      delivery({ status: 'pending', claimedAt: null, attemptCount: 5 }),
    ]);
    await dispatcher.runDueDeliveries(now);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(prisma.get('delivery-1')?.status).toBe('sent');
  });

  it('processes multiple due deliveries independently in the same tick', async () => {
    sendEmail.mockImplementation((params: { to: string }) =>
      params.to === 'jane@example.com'
        ? Promise.reject(new TemporaryNotificationDeliveryError('busy'))
        : Promise.resolve({ providerMessageId: 'msg-2' }),
    );
    const { dispatcher, prisma } = buildDispatcher([
      delivery({ id: 'delivery-1', recipientUserId: 'user-1' }),
      delivery({
        id: 'delivery-2',
        recipientUserId: 'user-2',
        idempotencyKey: 'automation-step:step-2',
      }),
    ]);
    prisma.users.set('user-2', { id: 'user-2', email: 'bob@example.com' });

    await dispatcher.runDueDeliveries(now);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(prisma.get('delivery-1')?.status).toBe('retry_scheduled');
    expect(prisma.get('delivery-2')?.status).toBe('sent');
  });

  it('one delivery throwing an unhandled error during processing never stops the rest of the tick', async () => {
    const { dispatcher, prisma } = buildDispatcher([
      delivery({ id: 'delivery-1', recipientUserId: 'user-1' }),
      delivery({
        id: 'delivery-2',
        recipientUserId: 'user-2',
        idempotencyKey: 'automation-step:step-2',
      }),
    ]);
    prisma.users.set('user-2', { id: 'user-2', email: 'bob@example.com' });
    const originalFindUnique = prisma.user.findUnique;
    prisma.user.findUnique = (
      args: Parameters<typeof originalFindUnique>[0],
    ) => {
      if (args.where.id === 'user-1') {
        throw new Error('unexpected database error');
      }
      return originalFindUnique(args);
    };

    await dispatcher.runDueDeliveries(now);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(prisma.get('delivery-2')?.status).toBe('sent');
    // delivery-1's claim is left in place — the crash-safety guarantee is
    // that it is retried once the lease goes stale, not silently dropped.
    expect(prisma.get('delivery-1')?.status).toBe('processing');
  });
});
