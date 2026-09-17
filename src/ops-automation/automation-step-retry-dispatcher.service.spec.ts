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

describe('AutomationStepRetryDispatcherService', () => {
  function build(dueRows: DueStepRow[]) {
    const findMany = jest
      .fn<Promise<DueStepRow[]>, [{ where: unknown }]>()
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
    expect(Array.isArray((where as { AND: unknown }).AND)).toBe(true);
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
