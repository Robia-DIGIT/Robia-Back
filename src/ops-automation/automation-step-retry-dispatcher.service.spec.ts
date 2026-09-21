import { AutomationStepRetryDispatcherService } from './automation-step-retry-dispatcher.service';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationsService } from './automations.service';

// Purpose-built, scoped to exactly what this dispatcher does: read the
// due-set via automationStepRun.findMany(), then hand each row's id to
// AutomationsService.retryStep() — which owns the actual claim/attempt
// logic and is tested on its own in automations.service.spec.ts. This test
// only verifies the tick's own responsibilities: it queries, it delegates,
// and one row's failure never stops the rest.
interface DueStepRow {
  id: string;
  runId: string;
}

interface FindManyOptions {
  where: unknown;
  orderBy: unknown;
  take: number;
}

describe('AutomationStepRetryDispatcherService', () => {
  function build(dueRows: DueStepRow[]) {
    const findMany = jest
      .fn<Promise<DueStepRow[]>, [FindManyOptions]>()
      .mockResolvedValue(dueRows);
    const prisma = { automationStepRun: { findMany } };
    const retryStep = jest
      .fn<Promise<void>, [string, Date]>()
      .mockResolvedValue(undefined);
    const automations = { retryStep };
    const service = new AutomationStepRetryDispatcherService(
      prisma as unknown as PrismaService,
      automations as unknown as AutomationsService,
    );
    return { service, prisma, automations };
  }

  it('calls retryStep for every row in the due-set', async () => {
    const { service, automations } = build([
      { id: 'step-1', runId: 'run-1' },
      { id: 'step-2', runId: 'run-2' },
    ]);
    const now = new Date('2026-09-17T12:00:00.000Z');

    await service.runDueRetries(now);

    expect(automations.retryStep).toHaveBeenCalledTimes(2);
    expect(automations.retryStep).toHaveBeenNthCalledWith(1, 'step-1', now);
    expect(automations.retryStep).toHaveBeenNthCalledWith(2, 'step-2', now);
  });

  it('queries automationStepRun.findMany with a due-set where clause keyed off `now`', async () => {
    const { service, prisma } = build([]);
    const now = new Date('2026-09-17T12:00:00.000Z');

    await service.runDueRetries(now);

    expect(prisma.automationStepRun.findMany).toHaveBeenCalledTimes(1);
    const [{ where }] = prisma.automationStepRun.findMany.mock.calls[0];
    expect(Array.isArray((where as { OR: unknown }).OR)).toBe(true);
  });

  // RC-27 hardening — the scan itself must never be unbounded: orderBy is
  // part of the query (Postgres decides the order, never an in-memory
  // sort after an unbounded findMany()), and take caps how many rows a
  // single tick can ever pull, however large the due-set has grown.
  it('bounds the due-set query with a deterministic orderBy and a take limit', async () => {
    const { service, prisma } = build([]);

    await service.runDueRetries(new Date());

    const [call] = prisma.automationStepRun.findMany.mock.calls[0];
    expect(Array.isArray(call.orderBy)).toBe(true);
    expect(typeof call.take).toBe('number');
    expect(call.take).toBeGreaterThan(0);
  });

  // RC-27 hardening — processing itself must never launch every due row at
  // once (an unbounded Promise.allSettled): only STEP_RETRY_MAX_CONCURRENCY
  // calls to retryStep() are ever in flight simultaneously.
  it('never has more than STEP_RETRY_MAX_CONCURRENCY retryStep calls in flight at once', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `step-${i}`,
      runId: `run-${i}`,
    }));
    const { service, automations } = build(rows);
    let inFlight = 0;
    let maxInFlight = 0;
    automations.retryStep.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
    });

    await service.runDueRetries(new Date());

    expect(automations.retryStep).toHaveBeenCalledTimes(12);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1); // actually exercises concurrency
  });

  it("one row's retryStep failure never stops the rest of the tick", async () => {
    const { service, automations } = build([
      { id: 'step-1', runId: 'run-1' },
      { id: 'step-2', runId: 'run-2' },
      { id: 'step-3', runId: 'run-3' },
    ]);
    automations.retryStep
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('DB blip'))
      .mockResolvedValueOnce(undefined);

    await expect(service.runDueRetries(new Date())).resolves.toBeUndefined();

    expect(automations.retryStep).toHaveBeenCalledTimes(3);
  });

  it('does nothing when the due-set is empty', async () => {
    const { service, automations } = build([]);

    await service.runDueRetries(new Date());

    expect(automations.retryStep).not.toHaveBeenCalled();
  });
});
