import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AutomationsService } from './automations.service';
import { AutomationContextService } from './automation-context.service';
import { OpsActionsRegistryService } from './actions/ops-actions-registry.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AutomationLoopError,
  AutomationRunConflictError,
  AutomationTooManyStepsError,
  AutomationValidationError,
} from './automation-errors';
import {
  MAX_STEPS_PER_AUTOMATION,
  MAX_TRIGGER_DEPTH,
} from './automation.constants';
import type { AutomationConditionContext } from './condition-engine';

// ---------------------------------------------------------------------
// A small, purpose-built in-memory fake of the exact Prisma call surface
// AutomationsService uses. A hand-stubbed mockResolvedValueOnce chain would
// be too brittle for an engine this stateful (idempotency and concurrency
// both depend on "create, then look the same row back up"); a fake with
// real read-your-writes semantics is far closer to how Postgres actually
// behaves, without requiring a live database in CI.
// ---------------------------------------------------------------------

interface FakeRecord {
  [key: string]: unknown;
}

function baseId(prefix: string, seq: number) {
  return `${prefix}-${seq}`;
}

// Real Postgres round-trips Prisma.JsonNull/Prisma.DbNull to a genuine JS
// `null` on read — FakePrisma stores raw JS values, so it must simulate
// that same normalization on write, or a field explicitly nulled via
// Prisma.JsonNull would come back as the sentinel object instead of `null`.
function normalizeJsonSentinels(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] =
      value === Prisma.JsonNull || value === Prisma.DbNull ? null : value;
  }
  return result;
}

class FakePrisma {
  automations = new Map<string, FakeRecord>();
  triggers = new Map<string, FakeRecord>(); // keyed by automationId
  runs = new Map<string, FakeRecord>();
  steps = new Map<string, FakeRecord>();
  events = new Map<string, FakeRecord>();
  private seq = 0;

  private id(prefix: string) {
    this.seq += 1;
    return baseId(prefix, this.seq);
  }

  private withTrigger(automation: FakeRecord, include?: { trigger?: boolean }) {
    if (!include?.trigger) return { ...automation };
    return {
      ...automation,
      trigger: this.triggers.get(automation.id as string) ?? null,
    };
  }

  private withSteps(run: FakeRecord, include?: { steps?: unknown }) {
    if (!include?.steps) return { ...run };
    const steps = Array.from(this.steps.values())
      .filter((s) => s.runId === run.id)
      .sort((a, b) => (a.sequence as number) - (b.sequence as number));
    return { ...run, steps };
  }

  automation = {
    create: ({
      data,
      include,
    }: {
      data: Record<string, unknown> & {
        trigger?: { create: Record<string, unknown> };
      };
      include?: { trigger?: boolean };
    }) => {
      const id = this.id('automation');
      const { trigger, ...rest } = data;
      const record: FakeRecord = {
        id,
        scope: 'ORGANIZATION',
        lastRunAt: null,
        nextRunAt: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...normalizeJsonSentinels(rest),
      };
      this.automations.set(id, record);
      if (trigger?.create) {
        this.triggers.set(id, {
          id: this.id('trigger'),
          automationId: id,
          config: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...trigger.create,
        });
      }
      return this.withTrigger(record, include);
    },
    findFirst: ({
      where,
      include,
    }: {
      where: { id?: string; organizationId?: string };
      include?: { trigger?: boolean };
    }) => {
      const record = Array.from(this.automations.values()).find(
        (a) =>
          (where.id === undefined || a.id === where.id) &&
          (where.organizationId === undefined ||
            a.organizationId === where.organizationId),
      );
      return record ? this.withTrigger(record, include) : null;
    },
    findMany: ({
      where,
      include,
    }: {
      where: {
        organizationId?: string;
        enabled?: boolean;
        trigger?: { type: string; eventType: string };
      };
      include?: { trigger?: boolean };
    }) => {
      let records = Array.from(this.automations.values()).filter(
        (a) =>
          (where.organizationId === undefined ||
            a.organizationId === where.organizationId) &&
          (where.enabled === undefined || a.enabled === where.enabled),
      );
      if (where.trigger) {
        records = records.filter((a) => {
          const trigger = this.triggers.get(a.id as string);
          return (
            trigger?.type === where.trigger?.type &&
            trigger?.eventType === where.trigger?.eventType
          );
        });
      }
      return records.map((r) => this.withTrigger(r, include));
    },
    update: ({
      where,
      data,
      include,
    }: {
      where: { id: string };
      data: Record<string, unknown> & {
        trigger?: {
          upsert?: {
            create: Record<string, unknown>;
            update: Record<string, unknown>;
          };
        };
      };
      include?: { trigger?: boolean };
    }) => {
      const record = this.automations.get(where.id);
      if (!record) throw new Error('FakePrisma: automation not found');
      const { trigger, ...rest } = data;
      Object.assign(record, normalizeJsonSentinels(rest), {
        updatedAt: new Date(),
      });
      if (trigger?.upsert) {
        const existing = this.triggers.get(where.id);
        if (existing) {
          Object.assign(existing, trigger.upsert.update);
        } else {
          this.triggers.set(where.id, {
            id: this.id('trigger'),
            automationId: where.id,
            config: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...trigger.upsert.create,
          });
        }
      }
      return this.withTrigger(record, include);
    },
  };

  automationRun = {
    findUnique: ({
      where,
      include,
    }: {
      where: {
        organizationId_dedupKey?: { organizationId: string; dedupKey: string };
      };
      include?: { steps?: unknown };
    }) => {
      if (where.organizationId_dedupKey) {
        const { organizationId, dedupKey } = where.organizationId_dedupKey;
        const record = Array.from(this.runs.values()).find(
          (r) => r.organizationId === organizationId && r.dedupKey === dedupKey,
        );
        return record ? this.withSteps(record, include) : null;
      }
      return null;
    },
    findFirst: ({
      where,
      include,
    }: {
      where: {
        automationId?: string;
        status?: { in: string[] };
        id?: string;
        organizationId?: string;
      };
      include?: { steps?: unknown };
    }) => {
      const record = Array.from(this.runs.values()).find(
        (r) =>
          (where.automationId === undefined ||
            r.automationId === where.automationId) &&
          (where.id === undefined || r.id === where.id) &&
          (where.organizationId === undefined ||
            r.organizationId === where.organizationId) &&
          (where.status === undefined ||
            (where.status.in ?? []).includes(r.status as string)),
      );
      return record ? this.withSteps(record, include) : null;
    },
    findMany: ({
      where,
    }: {
      where: { organizationId?: string; automationId?: string };
    }) => {
      return Array.from(this.runs.values())
        .filter(
          (r) =>
            (where.organizationId === undefined ||
              r.organizationId === where.organizationId) &&
            (where.automationId === undefined ||
              r.automationId === where.automationId),
        )
        .sort(
          (a, b) =>
            (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime(),
        );
    },
    create: ({
      data,
      include,
    }: {
      data: Record<string, unknown>;
      include?: { steps?: unknown };
    }) => {
      const organizationId = data.organizationId as string;
      const dedupKey = data.dedupKey as string;
      const clash = Array.from(this.runs.values()).find(
        (r) => r.organizationId === organizationId && r.dedupKey === dedupKey,
      );
      if (clash) {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          {
            code: 'P2002',
            clientVersion: '7.8.0',
          },
        );
      }
      const id = this.id('run');
      const record: FakeRecord = {
        id,
        createdAt: new Date(),
        approvedById: null,
        approvalStatus: null,
        approvalReason: null,
        approvedAt: null,
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
        context: null,
        sourceEventId: null,
        triggeredById: null,
        ...normalizeJsonSentinels(data),
      };
      this.runs.set(id, record);
      return this.withSteps(record, include);
    },
    update: ({
      where,
      data,
      include,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
      include?: { steps?: unknown };
    }) => {
      const record = this.runs.get(where.id);
      if (!record) throw new Error('FakePrisma: run not found');
      Object.assign(record, normalizeJsonSentinels(data));
      return this.withSteps(record, include);
    },
  };

  automationStepRun = {
    create: ({ data }: { data: Record<string, unknown> }) => {
      const id = this.id('step');
      const record: FakeRecord = {
        id,
        createdAt: new Date(),
        evidence: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        ...normalizeJsonSentinels(data),
      };
      this.steps.set(id, record);
      return record;
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const record = this.steps.get(where.id);
      if (!record) throw new Error('FakePrisma: step not found');
      Object.assign(record, normalizeJsonSentinels(data));
      return record;
    },
  };

  automationEvent = {
    findUnique: ({
      where,
    }: {
      where: {
        organizationId_eventKey?: { organizationId: string; eventKey: string };
        id?: string;
      };
    }) => {
      if (where.id !== undefined) {
        return this.events.get(where.id) ?? null;
      }
      if (!where.organizationId_eventKey) return null;
      const { organizationId, eventKey } = where.organizationId_eventKey;
      return (
        Array.from(this.events.values()).find(
          (e) => e.organizationId === organizationId && e.eventKey === eventKey,
        ) ?? null
      );
    },
    create: ({ data }: { data: Record<string, unknown> }) => {
      const organizationId = data.organizationId as string;
      const eventKey = data.eventKey as string;
      const clash = Array.from(this.events.values()).find(
        (e) => e.organizationId === organizationId && e.eventKey === eventKey,
      );
      if (clash) {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          {
            code: 'P2002',
            clientVersion: '7.8.0',
          },
        );
      }
      const id = this.id('event');
      const record: FakeRecord = {
        id,
        createdAt: new Date(),
        ...normalizeJsonSentinels(data),
      };
      this.events.set(id, record);
      return record;
    },
  };
}

function baseContext(
  overrides: Partial<AutomationConditionContext> = {},
): AutomationConditionContext {
  return {
    audit: { ageDays: 10, status: 'completed', globalScore: 70 },
    integration: {
      googleSearchConsole: { status: 'connected' },
      meta: { status: 'connected' },
    },
    opportunity: { count: 1, highPriorityCount: 0 },
    website: { count: 1 },
    ...overrides,
  };
}

describe('AutomationsService', () => {
  const orgA = 'org-a';
  const orgB = 'org-b';
  const userA = 'user-a';

  let prisma: FakePrisma;
  let context: { build: jest.Mock };
  let actionsRegistry: { isAllowed: jest.Mock; execute: jest.Mock };
  let service: AutomationsService;

  beforeEach(() => {
    prisma = new FakePrisma();
    context = { build: jest.fn().mockResolvedValue(baseContext()) };
    actionsRegistry = {
      isAllowed: jest
        .fn()
        .mockImplementation((type: string) =>
          [
            'robia.audit.run_diagnostic',
            'robia.opportunities.regenerate',
            'robia.report.prepare_organization_summary',
            'robia.action_items.create_internal_task',
          ].includes(type),
        ),
      execute: jest.fn().mockResolvedValue({ ok: true }),
    };
    service = new AutomationsService(
      prisma as unknown as PrismaService,
      context as unknown as AutomationContextService,
      actionsRegistry as unknown as OpsActionsRegistryService,
    );
  });

  function createDto(
    overrides: Partial<Parameters<AutomationsService['create']>[2]> = {},
  ) {
    return {
      name: 'Créer une tâche de suivi',
      trigger: { type: 'manual' as const },
      steps: [
        {
          actionType: 'robia.action_items.create_internal_task',
          input: { title: 'Vérifier le site' },
        },
      ],
      requiresApproval: false,
      enabled: true,
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------
  // Creation / validation
  // ---------------------------------------------------------------------

  describe('create', () => {
    it('creates an automation with its trigger', async () => {
      const automation = await service.create(orgA, userA, createDto());
      expect(automation.organizationId).toBe(orgA);
      expect(automation.trigger).toMatchObject({ type: 'manual' });
    });

    it('rejects a scheduled trigger without a cronExpression', async () => {
      await expect(
        service.create(
          orgA,
          userA,
          createDto({ trigger: { type: 'scheduled' } as never }),
        ),
      ).rejects.toBeInstanceOf(AutomationValidationError);
    });

    it('rejects an event trigger without an eventType', async () => {
      await expect(
        service.create(
          orgA,
          userA,
          createDto({ trigger: { type: 'event' } as never }),
        ),
      ).rejects.toBeInstanceOf(AutomationValidationError);
    });

    it('rejects a non-allowlisted action type (Ops action registry)', async () => {
      await expect(
        service.create(
          orgA,
          userA,
          createDto({
            steps: [{ actionType: 'shell.exec', input: {} }],
          }),
        ),
      ).rejects.toBeInstanceOf(AutomationValidationError);
    });

    it('rejects more than the maximum number of steps', async () => {
      const steps = Array.from(
        { length: MAX_STEPS_PER_AUTOMATION + 1 },
        () => ({
          actionType: 'robia.action_items.create_internal_task',
          input: { title: 'x' },
        }),
      );
      await expect(
        service.create(orgA, userA, createDto({ steps })),
      ).rejects.toBeInstanceOf(AutomationTooManyStepsError);
    });

    it('rejects an invalid condition tree (unknown field)', async () => {
      await expect(
        service.create(
          orgA,
          userA,
          createDto({
            conditions: {
              field: 'audit.__proto__',
              operator: 'eq',
              value: 'x',
            } as never,
          }),
        ),
      ).rejects.toBeInstanceOf(AutomationValidationError);
    });
  });

  // ---------------------------------------------------------------------
  // Organization isolation / unauthorized access
  // ---------------------------------------------------------------------

  describe('organization isolation', () => {
    it('never returns another organization automation via findOne', async () => {
      const automation = await service.create(orgA, userA, createDto());
      await expect(service.findOne(orgB, automation.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('never lists another organization automations', async () => {
      await service.create(orgA, userA, createDto());
      const listB = await service.findAll(orgB);
      expect(listB).toHaveLength(0);
    });

    it('never lets org B trigger org A automation manually', async () => {
      const automation = await service.create(orgA, userA, createDto());
      await expect(
        service.triggerManual(orgB, 'user-b', automation.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never returns another organization run via getRun', async () => {
      const automation = await service.create(orgA, userA, createDto());
      const run = await service.triggerManual(orgA, userA, automation.id);
      await expect(service.getRun(orgB, run.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('never lets org B approve org A run', async () => {
      const automation = await service.create(
        orgA,
        userA,
        createDto({ requiresApproval: true }),
      );
      const run = await service.triggerManual(orgA, userA, automation.id);
      await expect(
        service.approveRun(orgB, 'user-b', run.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------
  // Conditions
  // ---------------------------------------------------------------------

  describe('conditions', () => {
    it('runs immediately when the condition is true', async () => {
      context.build.mockResolvedValue(
        baseContext({ opportunity: { count: 3, highPriorityCount: 0 } }),
      );
      const automation = await service.create(
        orgA,
        userA,
        createDto({
          conditions: { field: 'opportunity.count', operator: 'gt', value: 0 },
        }),
      );
      const run = await service.triggerManual(orgA, userA, automation.id);
      expect(run.status).toBe('succeeded');
      expect(actionsRegistry.execute).toHaveBeenCalled();
    });

    it('skips the run when the condition is false, and never executes any step', async () => {
      context.build.mockResolvedValue(
        baseContext({ opportunity: { count: 0, highPriorityCount: 0 } }),
      );
      const automation = await service.create(
        orgA,
        userA,
        createDto({
          conditions: { field: 'opportunity.count', operator: 'gt', value: 0 },
        }),
      );
      const run = await service.triggerManual(orgA, userA, automation.id);
      expect(run.status).toBe('skipped');
      expect(actionsRegistry.execute).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // Disabled automation
  // ---------------------------------------------------------------------

  it('records a skipped run and never executes steps for a disabled automation', async () => {
    const automation = await service.create(
      orgA,
      userA,
      createDto({ enabled: false }),
    );
    const run = await service.triggerManual(orgA, userA, automation.id);
    expect(run.status).toBe('skipped');
    expect(run.errorMessage).toMatch(/disabled/i);
    expect(actionsRegistry.execute).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Step failure
  // ---------------------------------------------------------------------

  it('marks the run failed and stops after the first failing step, without running later steps', async () => {
    actionsRegistry.execute
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('Boom'));
    const automation = await service.create(
      orgA,
      userA,
      createDto({
        steps: [
          {
            actionType: 'robia.report.prepare_organization_summary',
            input: {},
          },
          {
            actionType: 'robia.action_items.create_internal_task',
            input: { title: 'x' },
          },
          {
            actionType: 'robia.action_items.create_internal_task',
            input: { title: 'y' },
          },
        ],
      }),
    );
    const run = await service.getRun(
      orgA,
      (await service.triggerManual(orgA, userA, automation.id)).id,
    );
    expect(run.status).toBe('failed');
    expect(actionsRegistry.execute).toHaveBeenCalledTimes(2);
    expect(run.steps).toHaveLength(2);
    expect(run.steps[0].status).toBe('succeeded');
    expect(run.steps[1].status).toBe('failed');
  });

  // ---------------------------------------------------------------------
  // Redaction
  // ---------------------------------------------------------------------

  it('redacts a secret-shaped string out of a step failure message before persisting it', async () => {
    actionsRegistry.execute.mockRejectedValue(
      new Error(
        'Call failed: token=eyJhbGciOiJIUzI1NiJ9.e30.4Adcj3UFYzPUVaVF43FmMab6RlaQD8A9V8wFzzht-KQ',
      ),
    );
    const automation = await service.create(orgA, userA, createDto());
    const started = await service.triggerManual(orgA, userA, automation.id);
    const run = await service.getRun(orgA, started.id);
    expect(run.status).toBe('failed');
    expect(run.errorMessage).not.toContain('eyJ');
    expect(run.errorMessage).toContain('[REDACTED]');
    expect(run.steps[0].error).not.toContain('eyJ');
  });

  // ---------------------------------------------------------------------
  // Approval / rejection
  // ---------------------------------------------------------------------

  describe('approval lifecycle', () => {
    it('waits for approval and never executes a step before approval', async () => {
      const automation = await service.create(
        orgA,
        userA,
        createDto({ requiresApproval: true }),
      );
      const run = await service.triggerManual(orgA, userA, automation.id);
      expect(run.status).toBe('waiting_approval');
      expect(run.approvalStatus).toBe('pending');
      expect(actionsRegistry.execute).not.toHaveBeenCalled();
    });

    it('executes the steps only after approval', async () => {
      const automation = await service.create(
        orgA,
        userA,
        createDto({ requiresApproval: true }),
      );
      const run = await service.triggerManual(orgA, userA, automation.id);
      const approved = await service.approveRun(orgA, 'approver-1', run.id);
      expect(approved.status).toBe('succeeded');
      expect(approved.approvalStatus).toBe('approved');
      expect(actionsRegistry.execute).toHaveBeenCalledTimes(1);
    });

    it('never executes any step after rejection, and marks the run cancelled', async () => {
      const automation = await service.create(
        orgA,
        userA,
        createDto({ requiresApproval: true }),
      );
      const run = await service.triggerManual(orgA, userA, automation.id);
      const rejected = await service.rejectRun(
        orgA,
        'approver-1',
        run.id,
        'Pas maintenant',
      );
      expect(rejected.status).toBe('cancelled');
      expect(rejected.approvalStatus).toBe('rejected');
      expect(rejected.steps).toHaveLength(0);
      expect(actionsRegistry.execute).not.toHaveBeenCalled();
    });

    it('refuses to approve a run that is not waiting for approval', async () => {
      const automation = await service.create(orgA, userA, createDto());
      const run = await service.triggerManual(orgA, userA, automation.id);
      expect(run.status).toBe('succeeded');
      await expect(
        service.approveRun(orgA, 'approver-1', run.id),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to reject an already-approved run', async () => {
      const automation = await service.create(
        orgA,
        userA,
        createDto({ requiresApproval: true }),
      );
      const run = await service.triggerManual(orgA, userA, automation.id);
      await service.approveRun(orgA, 'approver-1', run.id);
      await expect(
        service.rejectRun(orgA, 'approver-1', run.id),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ---------------------------------------------------------------------
  // Concurrency
  // ---------------------------------------------------------------------

  it('refuses a manual trigger while a run is already waiting for approval (concurrency limit)', async () => {
    const automation = await service.create(
      orgA,
      userA,
      createDto({ requiresApproval: true }),
    );
    await service.triggerManual(orgA, userA, automation.id);
    await expect(
      service.triggerManual(orgA, userA, automation.id),
    ).rejects.toBeInstanceOf(AutomationRunConflictError);
  });

  // ---------------------------------------------------------------------
  // Idempotency / duplicate event
  // ---------------------------------------------------------------------

  describe('event idempotency', () => {
    it('creates exactly one run when the same event is emitted twice (duplicate event)', async () => {
      const automation = await service.create(
        orgA,
        userA,
        createDto({ trigger: { type: 'event', eventType: 'audit.completed' } }),
      );
      await service.setEnabled(orgA, automation.id, true);

      const first = await service.emitEvent(
        orgA,
        'audit.completed',
        'audit-1',
        {},
      );
      const second = await service.emitEvent(
        orgA,
        'audit.completed',
        'audit-1',
        {},
      );

      expect(first.runs).toHaveLength(1);
      expect(second.runs).toHaveLength(1);
      expect(second.runs[0].id).toBe(first.runs[0].id);
      expect(first.event.id).toBe(second.event.id);

      const allRuns = await service.listRuns(orgA, automation.id);
      expect(allRuns).toHaveLength(1);
      expect(actionsRegistry.execute).toHaveBeenCalledTimes(1);
    });

    it('only triggers automations whose event trigger matches the emitted eventType', async () => {
      await service.create(
        orgA,
        userA,
        createDto({
          trigger: { type: 'event', eventType: 'integration.disconnected' },
        }),
      );
      const matching = await service.create(
        orgA,
        userA,
        createDto({ trigger: { type: 'event', eventType: 'audit.completed' } }),
      );

      const { runs } = await service.emitEvent(
        orgA,
        'audit.completed',
        'audit-2',
        {},
      );
      expect(runs).toHaveLength(1);
      expect(runs[0].automationId).toBe(matching.id);
    });

    it('resolves a {{event.<key>}} step input placeholder from the emitted event payload', async () => {
      const automation = await service.create(
        orgA,
        userA,
        createDto({
          trigger: { type: 'event', eventType: 'audit.completed' },
          steps: [
            {
              actionType: 'robia.opportunities.regenerate',
              input: { auditId: '{{event.auditId}}' },
            },
          ],
        }),
      );

      const { runs } = await service.emitEvent(
        orgA,
        'audit.completed',
        'audit-3',
        {
          auditId: 'audit-real-id',
        },
      );

      expect(runs[0].automationId).toBe(automation.id);
      expect(actionsRegistry.execute).toHaveBeenCalledWith(
        'robia.opportunities.regenerate',
        orgA,
        { auditId: 'audit-real-id' },
      );
      expect(runs[0].steps[0].input).toEqual({ auditId: 'audit-real-id' });
    });
  });

  // ---------------------------------------------------------------------
  // Loop protection
  // ---------------------------------------------------------------------

  it('refuses to start a run whose trigger chain exceeds the maximum depth (loop protection)', async () => {
    const automation = await service.create(orgA, userA, createDto());
    const serviceWithPrivateAccess = service as unknown as {
      startRun: (
        automation: unknown,
        opts: { triggerType: string; dedupKey: string; triggerDepth: number },
      ) => Promise<unknown>;
    };

    await expect(
      serviceWithPrivateAccess.startRun(automation, {
        triggerType: 'manual',
        dedupKey: 'loop-test',
        triggerDepth: MAX_TRIGGER_DEPTH + 1,
      }),
    ).rejects.toBeInstanceOf(AutomationLoopError);
    expect(actionsRegistry.execute).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // History is append-only
  // ---------------------------------------------------------------------

  it('never deletes a run or a step — history stays append-only', async () => {
    // FakePrisma deliberately implements no delete/deleteMany for either
    // model: if AutomationsService ever called one, this — and every other
    // test exercising a run — would fail with "not a function". Both the
    // run and its steps must still be readable afterwards.
    expect(
      (prisma.automationRun as unknown as Record<string, unknown>).delete,
    ).toBeUndefined();
    expect(
      (prisma.automationRun as unknown as Record<string, unknown>).deleteMany,
    ).toBeUndefined();
    expect(
      (prisma.automationStepRun as unknown as Record<string, unknown>).delete,
    ).toBeUndefined();
    expect(
      (prisma.automationStepRun as unknown as Record<string, unknown>)
        .deleteMany,
    ).toBeUndefined();

    const automation = await service.create(orgA, userA, createDto());
    const started = await service.triggerManual(orgA, userA, automation.id);
    const run = await service.getRun(orgA, started.id);
    expect(run.status).toBe('succeeded');
    expect(run.steps.length).toBeGreaterThan(0);
  });
});
