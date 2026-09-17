import { AutomationSchedulerService } from './automation-scheduler.service';
import { AutomationsService } from './automations.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeNextOccurrence } from './cron-schedule';
import { AutomationWithTrigger } from './automation.types';
import {
  SCHEDULER_MAX_BATCH_SIZE,
  SCHEDULER_MAX_CONCURRENCY,
} from './automation.constants';

interface FakeTriggerRecord {
  type: string;
  cronExpression: string | null;
  eventType: string | null;
  timezone: string;
}

interface FakeAutomationRecord {
  id: string;
  organizationId: string;
  enabled: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  scheduledClaimedAt: Date | null;
  trigger: FakeTriggerRecord | null;
}

type ClaimedAtClause =
  { scheduledClaimedAt: null } | { scheduledClaimedAt: { lt: Date } };

function matchesClaimedAtClause(
  record: FakeAutomationRecord,
  clause: ClaimedAtClause,
): boolean {
  if (clause.scheduledClaimedAt === null) {
    return record.scheduledClaimedAt === null;
  }
  return (
    record.scheduledClaimedAt !== null &&
    record.scheduledClaimedAt.getTime() < clause.scheduledClaimedAt.lt.getTime()
  );
}

// Purpose-built, scoped to exactly the three Prisma calls
// AutomationSchedulerService makes: automation.findMany() (the due-set and
// reconciliation reads), automation.findFirst() (the post-claim re-fetch),
// and automation.updateMany() (the atomic claim/release/advance). It
// mirrors the same synchronous find-then-mutate shape as
// automation(Run).updateMany in automations.service.spec.ts's own
// FakePrisma — no `await` inside the critical section — which is what
// makes a real concurrency test possible: two "concurrent" callers racing
// via Promise.all can never both see a matching row AND both win, the same
// way a real Postgres UPDATE...WHERE serializes two concurrent statements
// against the same row.
class FakeSchedulerPrisma {
  private records: Map<string, FakeAutomationRecord>;

  constructor(records: FakeAutomationRecord[]) {
    this.records = new Map(records.map((r) => [r.id, { ...r }]));
  }

  get(id: string): FakeAutomationRecord | undefined {
    return this.records.get(id);
  }

  automation = {
    findMany: ({
      where,
    }: {
      where: {
        enabled?: boolean;
        nextRunAt?: { lte: Date } | null;
        trigger?: { type: string };
        OR?: ClaimedAtClause[];
      };
    }): AutomationWithTrigger[] => {
      return Array.from(this.records.values())
        .filter((r) => {
          if (where.enabled !== undefined && r.enabled !== where.enabled) {
            return false;
          }
          if (where.nextRunAt !== undefined) {
            if (where.nextRunAt === null) {
              if (r.nextRunAt !== null) return false;
            } else if (
              r.nextRunAt === null ||
              r.nextRunAt.getTime() > where.nextRunAt.lte.getTime()
            ) {
              return false;
            }
          }
          if (
            where.trigger?.type !== undefined &&
            r.trigger?.type !== where.trigger.type
          ) {
            return false;
          }
          if (
            where.OR !== undefined &&
            !where.OR.some((clause) => matchesClaimedAtClause(r, clause))
          ) {
            return false;
          }
          return true;
        })
        .map(
          (r) =>
            ({
              ...r,
              trigger: r.trigger ? { ...r.trigger } : null,
            }) as unknown as AutomationWithTrigger,
        );
    },
    findFirst: ({
      where,
    }: {
      where: { id: string };
    }): AutomationWithTrigger | null => {
      const record = this.records.get(where.id);
      if (!record) return null;
      return {
        ...record,
        trigger: record.trigger ? { ...record.trigger } : null,
      } as unknown as AutomationWithTrigger;
    },
    updateMany: ({
      where,
      data,
    }: {
      where: {
        id: string;
        nextRunAt?: Date | null;
        enabled?: boolean;
        scheduledClaimedAt?: Date | null;
        OR?: ClaimedAtClause[];
      };
      data: Partial<
        Pick<
          FakeAutomationRecord,
          'nextRunAt' | 'lastRunAt' | 'scheduledClaimedAt'
        >
      >;
    }): { count: number } => {
      const record = this.records.get(where.id);
      if (!record) return { count: 0 };
      if (where.nextRunAt !== undefined) {
        const matches =
          where.nextRunAt === null
            ? record.nextRunAt === null
            : record.nextRunAt !== null &&
              record.nextRunAt.getTime() === where.nextRunAt.getTime();
        if (!matches) return { count: 0 };
      }
      if (where.enabled !== undefined && record.enabled !== where.enabled) {
        return { count: 0 };
      }
      if (where.scheduledClaimedAt !== undefined) {
        const matches =
          where.scheduledClaimedAt === null
            ? record.scheduledClaimedAt === null
            : record.scheduledClaimedAt !== null &&
              record.scheduledClaimedAt.getTime() ===
                where.scheduledClaimedAt.getTime();
        if (!matches) return { count: 0 };
      }
      if (
        where.OR !== undefined &&
        !where.OR.some((clause) => matchesClaimedAtClause(record, clause))
      ) {
        return { count: 0 };
      }
      Object.assign(record, data);
      return { count: 1 };
    },
  };
}

function automation(
  overrides: Partial<FakeAutomationRecord> = {},
): FakeAutomationRecord {
  return {
    id: 'automation-1',
    organizationId: 'org-1',
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    scheduledClaimedAt: null,
    trigger: {
      type: 'scheduled',
      cronExpression: '0 9 * * 1',
      eventType: null,
      timezone: 'Indian/Antananarivo',
    },
    ...overrides,
  };
}

describe('AutomationSchedulerService', () => {
  let triggerScheduled: jest.Mock;

  beforeEach(() => {
    triggerScheduled = jest.fn().mockResolvedValue({ id: 'run-1' });
  });

  function buildScheduler(records: FakeAutomationRecord[]) {
    const prisma = new FakeSchedulerPrisma(records);
    const scheduler = new AutomationSchedulerService(
      prisma as unknown as PrismaService,
      { triggerScheduled } as unknown as AutomationsService,
    );
    return { scheduler, prisma };
  }

  it('triggers an automation whose nextRunAt is due', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const scheduledFor = new Date('2026-09-21T06:00:00.000Z');
    const { scheduler } = buildScheduler([
      automation({ nextRunAt: scheduledFor }),
    ]);

    await scheduler.runDueAutomations(now);

    expect(triggerScheduled).toHaveBeenCalledTimes(1);
    expect(triggerScheduled).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'automation-1' }),
      scheduledFor,
    );
  });

  it('never triggers an automation that is not yet due', async () => {
    const now = new Date('2026-09-21T06:00:00.000Z');
    const { scheduler } = buildScheduler([
      automation({ nextRunAt: new Date('2026-09-21T07:00:00.000Z') }),
    ]);

    await scheduler.runDueAutomations(now);

    expect(triggerScheduled).not.toHaveBeenCalled();
  });

  it('never triggers a disabled automation even if its stored nextRunAt is due', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const { scheduler } = buildScheduler([
      automation({
        enabled: false,
        nextRunAt: new Date('2026-09-21T06:00:00.000Z'),
      }),
    ]);

    await scheduler.runDueAutomations(now);

    expect(triggerScheduled).not.toHaveBeenCalled();
  });

  it('never triggers a manual-trigger automation', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const { scheduler } = buildScheduler([
      automation({
        nextRunAt: new Date('2026-09-21T06:00:00.000Z'),
        trigger: {
          type: 'manual',
          cronExpression: null,
          eventType: null,
          timezone: 'UTC',
        },
      }),
    ]);

    await scheduler.runDueAutomations(now);

    expect(triggerScheduled).not.toHaveBeenCalled();
  });

  it('never triggers an event-trigger automation', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const { scheduler } = buildScheduler([
      automation({
        nextRunAt: new Date('2026-09-21T06:00:00.000Z'),
        trigger: {
          type: 'event',
          cronExpression: null,
          eventType: 'audit.completed',
          timezone: 'UTC',
        },
      }),
    ]);

    await scheduler.runDueAutomations(now);

    expect(triggerScheduled).not.toHaveBeenCalled();
  });

  it('allows exactly one catch-up run after a long gap, and advances nextRunAt to a future occurrence', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const longOverdue = new Date('2026-09-10T06:00:00.000Z'); // ~11 days overdue
    const { scheduler, prisma } = buildScheduler([
      automation({ nextRunAt: longOverdue }),
    ]);

    await scheduler.runDueAutomations(now);

    expect(triggerScheduled).toHaveBeenCalledTimes(1);
    const stored = prisma.get('automation-1');
    expect(stored?.nextRunAt).toEqual(
      computeNextOccurrence('0 9 * * 1', 'Indian/Antananarivo', now),
    );
    expect(stored!.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('never bursts through several missed occurrences in one tick', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const { scheduler } = buildScheduler([
      automation({
        nextRunAt: new Date('2026-08-01T06:00:00.000Z'), // ~7 missed Mondays
      }),
    ]);

    await scheduler.runDueAutomations(now);

    expect(triggerScheduled).toHaveBeenCalledTimes(1);
  });

  it('two concurrent dispatcher instances triggering the same due automation: only one wins', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const scheduledFor = new Date('2026-09-21T06:00:00.000Z');
    const prisma = new FakeSchedulerPrisma([
      automation({ nextRunAt: scheduledFor }),
    ]);
    const schedulerA = new AutomationSchedulerService(
      prisma as unknown as PrismaService,
      { triggerScheduled } as unknown as AutomationsService,
    );
    const schedulerB = new AutomationSchedulerService(
      prisma as unknown as PrismaService,
      { triggerScheduled } as unknown as AutomationsService,
    );

    await Promise.all([
      schedulerA.runDueAutomations(now),
      schedulerB.runDueAutomations(now),
    ]);

    expect(triggerScheduled).toHaveBeenCalledTimes(1);
  });

  it('two simultaneous ticks on the same instance: only one wins', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const scheduledFor = new Date('2026-09-21T06:00:00.000Z');
    const { scheduler } = buildScheduler([
      automation({ nextRunAt: scheduledFor }),
    ]);

    await Promise.all([
      scheduler.runDueAutomations(now),
      scheduler.runDueAutomations(now),
    ]);

    expect(triggerScheduled).toHaveBeenCalledTimes(1);
  });

  it('keeps processing the remaining due automations after one fails', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const scheduledFor = new Date('2026-09-21T06:00:00.000Z');
    triggerScheduled.mockImplementation((a: { id: string }) =>
      a.id === 'automation-1'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ id: 'run-2' }),
    );
    const { scheduler } = buildScheduler([
      automation({ id: 'automation-1', nextRunAt: scheduledFor }),
      automation({ id: 'automation-2', nextRunAt: scheduledFor }),
    ]);

    await scheduler.runDueAutomations(now);

    expect(triggerScheduled).toHaveBeenCalledTimes(2);
  });

  it('processes due automations from different organizations independently', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const scheduledFor = new Date('2026-09-21T06:00:00.000Z');
    const { scheduler } = buildScheduler([
      automation({
        id: 'automation-org-a',
        organizationId: 'org-a',
        nextRunAt: scheduledFor,
      }),
      automation({
        id: 'automation-org-b',
        organizationId: 'org-b',
        nextRunAt: scheduledFor,
      }),
    ]);

    await scheduler.runDueAutomations(now);

    expect(triggerScheduled).toHaveBeenCalledTimes(2);
    expect(triggerScheduled).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'automation-org-a',
        organizationId: 'org-a',
      }),
      scheduledFor,
    );
    expect(triggerScheduled).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'automation-org-b',
        organizationId: 'org-b',
      }),
      scheduledFor,
    );
  });

  // RC-25 review fix (Bloquant #1): a process crash — or any failure that
  // prevents the run from being durably created — between claiming an
  // occurrence and creating its run must never lose that occurrence.
  it('crash-then-recovery: a claimed occurrence whose run creation fails is retried by another instance once the lease goes stale, using the same scheduledFor', async () => {
    const scheduledFor = new Date('2026-09-21T06:00:00.000Z');
    const tick1 = new Date('2026-09-21T06:05:00.000Z');
    const prisma = new FakeSchedulerPrisma([
      automation({ nextRunAt: scheduledFor }),
    ]);

    // Tick 1, instance A: claims the occurrence, but the run is never
    // durably created (simulating a crash between the claim and run
    // creation) — modeled as a rejected triggerScheduled().
    triggerScheduled.mockRejectedValueOnce(new Error('simulated crash'));
    const instanceA = new AutomationSchedulerService(
      prisma as unknown as PrismaService,
      { triggerScheduled } as unknown as AutomationsService,
    );
    await instanceA.runDueAutomations(tick1);

    expect(triggerScheduled).toHaveBeenCalledTimes(1);
    const afterCrash = prisma.get('automation-1');
    // nextRunAt was never advanced past the lost occurrence: it is still
    // exactly the scheduledFor that was claimed, so nothing about the
    // occurrence itself was lost, only delayed.
    expect(afterCrash?.nextRunAt).toEqual(scheduledFor);
    expect(afterCrash?.scheduledClaimedAt).toEqual(tick1);

    // Tick 2, before the lease has gone stale, instance B (e.g. a
    // dispatcher pod that took over after the crashed one restarted): must
    // NOT reclaim yet — the lease is still fresh.
    const tooSoon = new Date(tick1.getTime() + 60_000);
    const instanceB = new AutomationSchedulerService(
      prisma as unknown as PrismaService,
      { triggerScheduled } as unknown as AutomationsService,
    );
    await instanceB.runDueAutomations(tooSoon);
    expect(triggerScheduled).toHaveBeenCalledTimes(1);

    // Tick 3, once the lease has gone stale: instance B reclaims the exact
    // same scheduledFor and this time succeeds.
    triggerScheduled.mockResolvedValueOnce({ id: 'run-recovered' });
    const tick2 = new Date(tick1.getTime() + 5 * 60 * 1000 + 1_000);
    await instanceB.runDueAutomations(tick2);

    expect(triggerScheduled).toHaveBeenCalledTimes(2);
    expect(triggerScheduled).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'automation-1' }),
      scheduledFor,
    );
    expect(triggerScheduled).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'automation-1' }),
      scheduledFor,
    );
    const recovered = prisma.get('automation-1');
    expect(recovered?.scheduledClaimedAt).toBeNull();
    expect(recovered?.nextRunAt).toEqual(
      computeNextOccurrence('0 9 * * 1', 'Indian/Antananarivo', tick2),
    );
    expect(recovered!.nextRunAt!.getTime()).toBeGreaterThan(tick2.getTime());
  });

  // RC-25 review fix (Bloquant #2): an automation disabled/modified in the
  // gap between the claim succeeding and the scheduler re-fetching fresh
  // state must never be executed — "one extra run" is not acceptable for a
  // future external action (e.g. an email step).
  it('never executes an automation disabled between the claim and the re-fetch', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const scheduledFor = new Date('2026-09-21T06:00:00.000Z');
    const { scheduler, prisma } = buildScheduler([
      automation({ nextRunAt: scheduledFor }),
    ]);
    const originalUpdateMany = prisma.automation.updateMany;
    prisma.automation.updateMany = (
      args: Parameters<typeof originalUpdateMany>[0],
    ) => {
      const result = originalUpdateMany(args);
      const isClaimCall =
        result.count === 1 &&
        'scheduledClaimedAt' in args.data &&
        args.data.scheduledClaimedAt instanceof Date &&
        !('nextRunAt' in args.data);
      if (isClaimCall) {
        // Simulates a disable landing in the DB in the instant between this
        // claim committing and the scheduler's own re-fetch.
        const record = prisma.get(args.where.id);
        if (record) record.enabled = false;
      }
      return result;
    };

    await scheduler.runDueAutomations(now);

    expect(triggerScheduled).not.toHaveBeenCalled();
    const stored = prisma.get('automation-1');
    // Lease released, nextRunAt untouched — never silently advanced past an
    // occurrence that was never actually executed.
    expect(stored?.scheduledClaimedAt).toBeNull();
    expect(stored?.nextRunAt).toEqual(scheduledFor);
  });

  // RC-25 second review fix (Bloquant): checking enabled/type/cron alone on
  // the re-fetch is not enough — a disable-then-re-enable that lands
  // between the claim and the re-fetch leaves `enabled: true` (and a valid
  // trigger), but AutomationsService.setEnabled() will have rewritten
  // nextRunAt to a *new* occurrence and cleared scheduledClaimedAt. Without
  // also re-checking nextRunAt/scheduledClaimedAt, the scheduler would
  // execute the automation against the stale, already-superseded
  // occurrence it originally claimed.
  it('never executes the originally-claimed occurrence after a disable-then-re-enable lands between the claim and the re-fetch', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const scheduledFor = new Date('2026-09-21T06:00:00.000Z');
    const newOccurrence = new Date('2026-09-28T06:00:00.000Z');
    const { scheduler, prisma } = buildScheduler([
      automation({ nextRunAt: scheduledFor }),
    ]);
    const originalUpdateMany = prisma.automation.updateMany;
    prisma.automation.updateMany = (
      args: Parameters<typeof originalUpdateMany>[0],
    ) => {
      const result = originalUpdateMany(args);
      const isClaimCall =
        result.count === 1 &&
        'scheduledClaimedAt' in args.data &&
        args.data.scheduledClaimedAt instanceof Date &&
        !('nextRunAt' in args.data);
      if (isClaimCall) {
        // Simulates AutomationsService.setEnabled(false) immediately
        // followed by setEnabled(true) landing between this claim
        // committing and the scheduler's own re-fetch: enabled stays
        // true, but nextRunAt is rewritten to a new occurrence and the
        // claim is cleared (see setEnabled()'s RC-25 review fix).
        const record = prisma.get(args.where.id);
        if (record) {
          record.nextRunAt = newOccurrence;
          record.scheduledClaimedAt = null;
        }
      }
      return result;
    };

    await scheduler.runDueAutomations(now);

    expect(triggerScheduled).not.toHaveBeenCalled();
    const stored = prisma.get('automation-1');
    // The new occurrence set by the simulated re-enable is left exactly as
    // is — the scheduler must not touch it, only abort.
    expect(stored?.nextRunAt).toEqual(newOccurrence);
    expect(stored?.scheduledClaimedAt).toBeNull();
  });

  // RC-25 second review fix (Bloquant): same race, triggered by a
  // cron/timezone edit instead of a disable/re-enable — AutomationsService
  // .update() also rewrites nextRunAt and clears scheduledClaimedAt.
  it('never executes the originally-claimed occurrence after a cron/timezone edit lands between the claim and the re-fetch', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const scheduledFor = new Date('2026-09-21T06:00:00.000Z');
    const newOccurrence = new Date('2026-09-21T18:00:00.000Z');
    const { scheduler, prisma } = buildScheduler([
      automation({ nextRunAt: scheduledFor }),
    ]);
    const originalUpdateMany = prisma.automation.updateMany;
    prisma.automation.updateMany = (
      args: Parameters<typeof originalUpdateMany>[0],
    ) => {
      const result = originalUpdateMany(args);
      const isClaimCall =
        result.count === 1 &&
        'scheduledClaimedAt' in args.data &&
        args.data.scheduledClaimedAt instanceof Date &&
        !('nextRunAt' in args.data);
      if (isClaimCall) {
        // Simulates AutomationsService.update() editing the cron
        // expression landing between this claim committing and the
        // scheduler's own re-fetch: the trigger is still valid and
        // scheduled, but nextRunAt now reflects the new cron and the
        // claim was cleared.
        const record = prisma.get(args.where.id);
        if (record) {
          if (record.trigger) record.trigger.cronExpression = '0 18 * * 1';
          record.nextRunAt = newOccurrence;
          record.scheduledClaimedAt = null;
        }
      }
      return result;
    };

    await scheduler.runDueAutomations(now);

    expect(triggerScheduled).not.toHaveBeenCalled();
    const stored = prisma.get('automation-1');
    expect(stored?.nextRunAt).toEqual(newOccurrence);
    expect(stored?.scheduledClaimedAt).toBeNull();
  });

  // RC-25 review fix (Important #3): a pre-RC25 automation that was already
  // enabled+scheduled has nextRunAt=null (nothing ever computed it), and a
  // `nextRunAt <= now` filter never matches NULL — it must be reconciled.
  it('initializes nextRunAt for a pre-existing scheduled automation stuck at null (reconciliation)', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const { scheduler, prisma } = buildScheduler([
      automation({ nextRunAt: null }),
    ]);

    await scheduler.runDueAutomations(now);

    const stored = prisma.get('automation-1');
    expect(stored?.nextRunAt).toEqual(
      computeNextOccurrence('0 9 * * 1', 'Indian/Antananarivo', now),
    );
    expect(stored!.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    // Just initialized on this same tick, not due yet — no run.
    expect(triggerScheduled).not.toHaveBeenCalled();
  });

  it('reconciliation never touches manual or event automations', async () => {
    const now = new Date('2026-09-21T06:05:00.000Z');
    const { scheduler, prisma } = buildScheduler([
      automation({
        id: 'manual-1',
        nextRunAt: null,
        trigger: {
          type: 'manual',
          cronExpression: null,
          eventType: null,
          timezone: 'UTC',
        },
      }),
      automation({
        id: 'event-1',
        nextRunAt: null,
        trigger: {
          type: 'event',
          cronExpression: null,
          eventType: 'audit.completed',
          timezone: 'UTC',
        },
      }),
    ]);

    await scheduler.runDueAutomations(now);

    expect(prisma.get('manual-1')?.nextRunAt).toBeNull();
    expect(prisma.get('event-1')?.nextRunAt).toBeNull();
    expect(triggerScheduled).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // RC-25 hardening fix: bounded-concurrency batch processing within a
  // single tick — SCHEDULER_MAX_CONCURRENCY in flight at a time,
  // SCHEDULER_MAX_BATCH_SIZE attempted at most, oldest nextRunAt first.
  // Every automation's own two-phase claim/re-fetch is untouched (proven by
  // the existing concurrency/reclaim tests above, all still green with
  // this batch/pool wrapped around them) — these tests only exercise the
  // pool itself.
  // ---------------------------------------------------------------------

  describe('bounded concurrency within a tick', () => {
    function dueAutomations(count: number, now: Date): FakeAutomationRecord[] {
      const scheduledFor = new Date(now.getTime() - 60_000);
      return Array.from({ length: count }, (_, i) =>
        automation({
          id: `automation-${i + 1}`,
          nextRunAt: scheduledFor,
        }),
      );
    }

    it('does not let a slow first automation block the start of the others', async () => {
      const now = new Date('2026-09-21T06:05:00.000Z');
      let releaseSlow!: () => void;
      const slowPromise = new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      const started: string[] = [];
      triggerScheduled.mockImplementation(
        async (a: { id: string }): Promise<{ id: string }> => {
          started.push(a.id);
          if (a.id === 'automation-1') {
            await slowPromise;
          }
          return { id: `run-${a.id}` };
        },
      );
      const { scheduler } = buildScheduler(dueAutomations(4, now));

      const runPromise = scheduler.runDueAutomations(now);
      // Flush microtasks so every worker gets to start its first item
      // without waiting for automation-1's own artificial delay to clear.
      await new Promise((resolve) => setImmediate(resolve));

      expect(started).toEqual(
        expect.arrayContaining([
          'automation-1',
          'automation-2',
          'automation-3',
          'automation-4',
        ]),
      );

      releaseSlow();
      await runPromise;
      expect(triggerScheduled).toHaveBeenCalledTimes(4);
    });

    it('never runs more than SCHEDULER_MAX_CONCURRENCY automations at the same time', async () => {
      const now = new Date('2026-09-21T06:05:00.000Z');
      const total = SCHEDULER_MAX_CONCURRENCY * 2 + 3;
      let inFlight = 0;
      let maxInFlight = 0;
      triggerScheduled.mockImplementation(
        async (a: { id: string }): Promise<{ id: string }> => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { id: `run-${a.id}` };
        },
      );
      const { scheduler } = buildScheduler(dueAutomations(total, now));

      await scheduler.runDueAutomations(now);

      expect(triggerScheduled).toHaveBeenCalledTimes(total);
      expect(maxInFlight).toBeLessThanOrEqual(SCHEDULER_MAX_CONCURRENCY);
      // The pool is actually exercised (not accidentally serialized) —
      // otherwise this assertion would be vacuous.
      expect(maxInFlight).toBeGreaterThan(1);
    });

    it('a rejected automation in the middle of the batch never prevents the others from completing', async () => {
      const now = new Date('2026-09-21T06:05:00.000Z');
      const total = SCHEDULER_MAX_CONCURRENCY + 2;
      triggerScheduled.mockImplementation(
        (a: { id: string }): Promise<{ id: string }> => {
          if (a.id === 'automation-3') {
            return Promise.reject(new Error('boom'));
          }
          return Promise.resolve({ id: `run-${a.id}` });
        },
      );
      const { scheduler, prisma } = buildScheduler(dueAutomations(total, now));

      await scheduler.runDueAutomations(now);

      expect(triggerScheduled).toHaveBeenCalledTimes(total);
      for (let i = 1; i <= total; i += 1) {
        const id = `automation-${i}`;
        if (id === 'automation-3') {
          // Failed to durably create a run: nextRunAt is left untouched,
          // to be retried, never silently advanced.
          expect(prisma.get(id)?.nextRunAt).not.toBeNull();
          expect(prisma.get(id)?.scheduledClaimedAt).toEqual(now);
        } else {
          expect(prisma.get(id)?.scheduledClaimedAt).toBeNull();
        }
      }
    });

    it('attempts at most SCHEDULER_MAX_BATCH_SIZE automations in one tick, oldest nextRunAt first', async () => {
      const now = new Date('2026-09-21T06:05:00.000Z');
      const total = SCHEDULER_MAX_BATCH_SIZE + 5;
      // Distinct, strictly increasing nextRunAt per automation so "oldest
      // first" has an unambiguous, verifiable order — automation-1 is the
      // most overdue, automation-N the least.
      const records = Array.from({ length: total }, (_, i) =>
        automation({
          id: `automation-${i + 1}`,
          nextRunAt: new Date(now.getTime() - (total - i) * 1_000),
        }),
      );
      const { scheduler } = buildScheduler(records);

      await scheduler.runDueAutomations(now);

      expect(triggerScheduled).toHaveBeenCalledTimes(SCHEDULER_MAX_BATCH_SIZE);
      const attemptedIds = triggerScheduled.mock.calls.map(
        ([a]: [{ id: string }]) => a.id,
      );
      const expectedIds = Array.from(
        { length: SCHEDULER_MAX_BATCH_SIZE },
        (_, i) => `automation-${i + 1}`,
      );
      expect(new Set(attemptedIds)).toEqual(new Set(expectedIds));
    });

    it('leaves the automations left out of a bounded batch untouched, to be picked up by the next tick', async () => {
      const now = new Date('2026-09-21T06:05:00.000Z');
      const total = SCHEDULER_MAX_BATCH_SIZE + 1;
      const records = Array.from({ length: total }, (_, i) =>
        automation({
          id: `automation-${i + 1}`,
          nextRunAt: new Date(now.getTime() - (total - i) * 1_000),
        }),
      );
      const { scheduler, prisma } = buildScheduler(records);
      const leftOutId = `automation-${total}`; // the least-overdue one

      await scheduler.runDueAutomations(now);

      expect(triggerScheduled).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: leftOutId }),
        expect.anything(),
      );
      const leftOut = prisma.get(leftOutId);
      expect(leftOut?.scheduledClaimedAt).toBeNull();
      expect(leftOut?.nextRunAt).toEqual(new Date(now.getTime() - 1_000));
    });
  });
});
