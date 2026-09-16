import { AutomationSchedulerService } from './automation-scheduler.service';
import { AutomationsService } from './automations.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeNextOccurrence } from './cron-schedule';
import { AutomationWithTrigger } from './automation.types';

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
  trigger: FakeTriggerRecord | null;
}

// Purpose-built, scoped to exactly the two Prisma calls
// AutomationSchedulerService makes: automation.findMany() (the due-set
// read) and automation.updateMany() (the atomic claim). It mirrors the
// same synchronous find-then-mutate shape as automation(Run).updateMany in
// automations.service.spec.ts's own FakePrisma — no `await` inside the
// critical section — which is what makes a real concurrency test possible:
// two "concurrent" callers racing via Promise.all can never both see a
// matching row AND both win, the same way a real Postgres UPDATE...WHERE
// serializes two concurrent statements against the same row.
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
        nextRunAt?: { lte: Date };
        trigger?: { type: string };
      };
    }): AutomationWithTrigger[] => {
      return Array.from(this.records.values())
        .filter(
          (r) =>
            (where.enabled === undefined || r.enabled === where.enabled) &&
            (where.nextRunAt?.lte === undefined ||
              (r.nextRunAt !== null &&
                r.nextRunAt.getTime() <= where.nextRunAt.lte.getTime())) &&
            (where.trigger?.type === undefined ||
              r.trigger?.type === where.trigger.type),
        )
        .map(
          (r) =>
            ({
              ...r,
              trigger: r.trigger ? { ...r.trigger } : null,
            }) as unknown as AutomationWithTrigger,
        );
    },
    updateMany: ({
      where,
      data,
    }: {
      where: { id: string; nextRunAt: Date | null };
      data: { nextRunAt: Date; lastRunAt: Date };
    }): { count: number } => {
      const record = this.records.get(where.id);
      const matches =
        !!record &&
        (record.nextRunAt === null
          ? where.nextRunAt === null
          : where.nextRunAt !== null &&
            record.nextRunAt.getTime() === where.nextRunAt.getTime());
      if (!matches) {
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
});
