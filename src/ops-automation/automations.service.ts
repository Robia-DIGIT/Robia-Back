import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { redactSensitive } from '../common/logging/redact';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { AutomationTriggerDto } from './dto/automation-trigger.dto';
import { AutomationStepDto } from './dto/automation-step.dto';
import {
  ConditionNode,
  InvalidConditionError,
  evaluateConditions,
  validateConditionTree,
} from './condition-engine';
import { AutomationContextService } from './automation-context.service';
import { resolveStepInput } from './automation-templating';
import { OpsActionsRegistryService } from './actions/ops-actions-registry.service';
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
import {
  AutomationRunWithSteps,
  AutomationWithTrigger,
  readStoredSteps,
} from './automation.types';

const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting_approval'];

interface StartRunOptions {
  triggerType: 'manual' | 'scheduled' | 'event';
  dedupKey: string;
  triggeredById?: string;
  sourceEventId?: string;
  triggerDepth?: number;
}

@Injectable()
export class AutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: AutomationContextService,
    private readonly actionsRegistry: OpsActionsRegistryService,
  ) {}

  // ---------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------

  async create(
    organizationId: string,
    userId: string,
    dto: CreateAutomationDto,
  ) {
    this.validateTrigger(dto.trigger);
    this.validateSteps(dto.steps);
    this.validateConditions(dto.conditions);

    return this.prisma.automation.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description ?? null,
        enabled: dto.enabled ?? false,
        conditions: (dto.conditions ??
          Prisma.JsonNull) as Prisma.InputJsonValue,
        steps: dto.steps as unknown as Prisma.InputJsonValue,
        requiresApproval: dto.requiresApproval ?? true,
        createdById: userId,
        trigger: {
          create: {
            type: dto.trigger.type,
            cronExpression: dto.trigger.cronExpression ?? null,
            eventType: dto.trigger.eventType ?? null,
          },
        },
      },
      include: { trigger: true },
    });
  }

  async findAll(organizationId: string) {
    return this.prisma.automation.findMany({
      where: { organizationId },
      include: { trigger: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(
    organizationId: string,
    id: string,
  ): Promise<AutomationWithTrigger> {
    const automation = await this.prisma.automation.findFirst({
      where: { id, organizationId },
      include: { trigger: true },
    });
    if (!automation) {
      throw new NotFoundException('Automation non trouvée.');
    }
    return automation;
  }

  async update(organizationId: string, id: string, dto: UpdateAutomationDto) {
    await this.findOne(organizationId, id);

    if (dto.trigger) {
      this.validateTrigger(dto.trigger);
    }
    if (dto.steps) {
      this.validateSteps(dto.steps);
    }
    if (dto.conditions !== undefined) {
      this.validateConditions(dto.conditions);
    }

    return this.prisma.automation.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.requiresApproval !== undefined
          ? { requiresApproval: dto.requiresApproval }
          : {}),
        ...(dto.conditions !== undefined
          ? {
              conditions: (dto.conditions ??
                Prisma.JsonNull) as Prisma.InputJsonValue,
            }
          : {}),
        ...(dto.steps !== undefined
          ? { steps: dto.steps as unknown as Prisma.InputJsonValue }
          : {}),
        ...(dto.trigger
          ? {
              trigger: {
                upsert: {
                  create: {
                    type: dto.trigger.type,
                    cronExpression: dto.trigger.cronExpression ?? null,
                    eventType: dto.trigger.eventType ?? null,
                  },
                  update: {
                    type: dto.trigger.type,
                    cronExpression: dto.trigger.cronExpression ?? null,
                    eventType: dto.trigger.eventType ?? null,
                  },
                },
              },
            }
          : {}),
      },
      include: { trigger: true },
    });
  }

  async setEnabled(organizationId: string, id: string, enabled: boolean) {
    await this.findOne(organizationId, id);
    return this.prisma.automation.update({
      where: { id },
      data: { enabled },
      include: { trigger: true },
    });
  }

  // ---------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------

  async triggerManual(
    organizationId: string,
    userId: string,
    automationId: string,
  ) {
    const automation = await this.findOne(organizationId, automationId);
    return this.startRun(automation, {
      triggerType: 'manual',
      // A manual click is always a deliberate, distinct action — never
      // deduplicated against a previous one (unlike an emitted event).
      dedupKey: `manual:${randomUUID()}`,
      triggeredById: userId,
    });
  }

  async listRuns(organizationId: string, automationId: string) {
    await this.findOne(organizationId, automationId);
    return this.prisma.automationRun.findMany({
      where: { organizationId, automationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getRun(
    organizationId: string,
    runId: string,
  ): Promise<AutomationRunWithSteps> {
    const run = await this.prisma.automationRun.findFirst({
      where: { id: runId, organizationId },
      include: { steps: { orderBy: { sequence: 'asc' } } },
    });
    if (!run) {
      throw new NotFoundException('Run non trouvé.');
    }
    return run;
  }

  async approveRun(
    organizationId: string,
    userId: string,
    runId: string,
    reason?: string,
  ): Promise<AutomationRunWithSteps> {
    const run = await this.getRun(organizationId, runId);
    if (run.status !== 'waiting_approval') {
      throw new ConflictException("Ce run n'est pas en attente d'approbation.");
    }

    const automation = await this.prisma.automation.findFirst({
      where: { id: run.automationId, organizationId },
      include: { trigger: true },
    });
    if (!automation) {
      throw new NotFoundException('Automation non trouvée.');
    }

    const approved = await this.prisma.automationRun.update({
      where: { id: run.id },
      data: {
        approvalStatus: 'approved',
        approvedById: userId,
        approvalReason: reason ?? null,
        approvedAt: new Date(),
        status: 'running',
        startedAt: new Date(),
      },
      include: { steps: true },
    });

    return this.executeSteps(automation, approved);
  }

  async rejectRun(
    organizationId: string,
    userId: string,
    runId: string,
    reason?: string,
  ): Promise<AutomationRunWithSteps> {
    const run = await this.getRun(organizationId, runId);
    if (run.status !== 'waiting_approval') {
      throw new ConflictException("Ce run n'est pas en attente d'approbation.");
    }

    // Rejected means rejected: status goes straight to 'cancelled' and
    // executeSteps() is never called — no step is ever created for this run.
    return this.prisma.automationRun.update({
      where: { id: run.id },
      data: {
        approvalStatus: 'rejected',
        approvedById: userId,
        approvalReason: reason ?? null,
        approvedAt: new Date(),
        status: 'cancelled',
        finishedAt: new Date(),
      },
      include: { steps: { orderBy: { sequence: 'asc' } } },
    });
  }

  // ---------------------------------------------------------------------
  // Event ingestion (RC-20's "système d'événements"). Nothing in this PR
  // calls this from AuditsService/MetaService/etc. — it exists so the
  // "event" trigger type is real and testable without altering any
  // existing module's behavior.
  // ---------------------------------------------------------------------

  async emitEvent(
    organizationId: string,
    eventType: string,
    eventKey: string,
    payload?: Record<string, unknown>,
  ): Promise<{ event: { id: string }; runs: AutomationRunWithSteps[] }> {
    const event = await this.getOrCreateEvent(
      organizationId,
      eventType,
      eventKey,
      payload,
    );

    const automations = await this.prisma.automation.findMany({
      where: {
        organizationId,
        enabled: true,
        trigger: { type: 'event', eventType },
      },
      include: { trigger: true },
    });

    const runs: AutomationRunWithSteps[] = [];
    for (const automation of automations) {
      const run = await this.startRun(automation, {
        triggerType: 'event',
        // Deterministic from the event's own identity: emitting the exact
        // same (organizationId, eventKey) pair twice always resolves to the
        // same underlying AutomationEvent row, so this key never changes
        // across duplicate emissions — the run is created at most once.
        dedupKey: `event:${event.id}`,
        sourceEventId: event.id,
      });
      runs.push(run);
    }

    return { event, runs };
  }

  private async getOrCreateEvent(
    organizationId: string,
    eventType: string,
    eventKey: string,
    payload?: Record<string, unknown>,
  ) {
    const existing = await this.prisma.automationEvent.findUnique({
      where: { organizationId_eventKey: { organizationId, eventKey } },
    });
    if (existing) {
      return existing;
    }
    try {
      return await this.prisma.automationEvent.create({
        data: {
          organizationId,
          eventType,
          eventKey,
          payload: (payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.automationEvent.findUnique({
          where: { organizationId_eventKey: { organizationId, eventKey } },
        });
        if (raced) return raced;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------

  private async startRun(
    automation: AutomationWithTrigger,
    opts: StartRunOptions,
  ): Promise<AutomationRunWithSteps> {
    const triggerDepth = opts.triggerDepth ?? 0;
    if (triggerDepth > MAX_TRIGGER_DEPTH) {
      throw new AutomationLoopError(MAX_TRIGGER_DEPTH);
    }

    // Idempotency: the same dedupKey never produces a second run. This is
    // checked first, before anything else, so a duplicate event replays the
    // exact original outcome rather than re-deciding it.
    const existingRun = await this.prisma.automationRun.findUnique({
      where: {
        organizationId_dedupKey: {
          organizationId: automation.organizationId,
          dedupKey: opts.dedupKey,
        },
      },
      include: { steps: { orderBy: { sequence: 'asc' } } },
    });
    if (existingRun) {
      return existingRun;
    }

    if (!automation.enabled) {
      return this.persistRun(automation, opts, {
        status: 'skipped',
        errorMessage: 'Automation is disabled.',
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    }

    const activeRun = await this.prisma.automationRun.findFirst({
      where: {
        automationId: automation.id,
        status: { in: ACTIVE_RUN_STATUSES },
      },
    });
    if (activeRun) {
      throw new AutomationRunConflictError();
    }

    const steps = readStoredSteps(automation.steps);
    if (steps.length > MAX_STEPS_PER_AUTOMATION) {
      throw new AutomationTooManyStepsError(MAX_STEPS_PER_AUTOMATION);
    }

    const context = await this.context.build(automation.organizationId);
    const conditionsPass = evaluateConditions(
      automation.conditions as ConditionNode | null,
      context,
    );
    const sanitizedContext = redactSensitive(context) as Prisma.InputJsonValue;

    await this.prisma.automation.update({
      where: { id: automation.id },
      data: { lastRunAt: new Date() },
    });

    if (!conditionsPass) {
      return this.persistRun(automation, opts, {
        status: 'skipped',
        context: sanitizedContext,
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    }

    if (automation.requiresApproval) {
      const run = await this.persistRun(automation, opts, {
        status: 'waiting_approval',
        requiresApproval: true,
        approvalStatus: 'pending',
        context: sanitizedContext,
      });
      return run;
    }

    const run = await this.persistRun(automation, opts, {
      status: 'running',
      context: sanitizedContext,
      startedAt: new Date(),
    });
    return this.executeSteps(automation, run);
  }

  private async persistRun(
    automation: AutomationWithTrigger,
    opts: StartRunOptions,
    extra: Partial<Prisma.AutomationRunUncheckedCreateInput>,
  ): Promise<AutomationRunWithSteps> {
    const data: Prisma.AutomationRunUncheckedCreateInput = {
      organizationId: automation.organizationId,
      automationId: automation.id,
      triggerType: opts.triggerType,
      dedupKey: opts.dedupKey,
      triggeredById: opts.triggeredById ?? null,
      sourceEventId: opts.sourceEventId ?? null,
      requiresApproval: automation.requiresApproval,
      status: 'queued',
      ...extra,
    };

    try {
      return await this.prisma.automationRun.create({
        data,
        include: { steps: { orderBy: { sequence: 'asc' } } },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.automationRun.findUnique({
          where: {
            organizationId_dedupKey: {
              organizationId: automation.organizationId,
              dedupKey: opts.dedupKey,
            },
          },
          include: { steps: { orderBy: { sequence: 'asc' } } },
        });
        if (raced) return raced;
      }
      throw error;
    }
  }

  private async executeSteps(
    automation: AutomationWithTrigger,
    run: AutomationRunWithSteps,
  ): Promise<AutomationRunWithSteps> {
    const steps = readStoredSteps(automation.steps);
    if (steps.length > MAX_STEPS_PER_AUTOMATION) {
      return this.finishRun(
        run.id,
        'failed',
        `Automation exceeds the maximum of ${MAX_STEPS_PER_AUTOMATION} steps.`,
      );
    }

    // RC-20: a step's input may reference the triggering event's payload
    // via a literal "{{event.<key>}}" placeholder (see
    // automation-templating.ts) — fetched once, up front, rather than per
    // step. A manual/scheduled run has no source event, so eventPayload
    // stays null and any such placeholder simply resolves to null.
    const sourceEvent = run.sourceEventId
      ? await this.prisma.automationEvent.findUnique({
          where: { id: run.sourceEventId },
        })
      : null;
    const eventPayload =
      (sourceEvent?.payload as Record<string, unknown> | null) ?? null;

    let sequence = 0;
    for (const step of steps) {
      sequence += 1;
      const resolvedInput = resolveStepInput(step.input, eventPayload);

      if (!this.actionsRegistry.isAllowed(step.actionType)) {
        await this.prisma.automationStepRun.create({
          data: {
            runId: run.id,
            sequence,
            actionType: step.actionType,
            input: (resolvedInput ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            status: 'failed',
            error: `Action type "${step.actionType}" is not in the Ops action allowlist.`,
            startedAt: new Date(),
            finishedAt: new Date(),
          },
        });
        return this.finishRun(
          run.id,
          'failed',
          `Action type "${step.actionType}" is not in the Ops action allowlist.`,
        );
      }

      const stepRun = await this.prisma.automationStepRun.create({
        data: {
          runId: run.id,
          sequence,
          actionType: step.actionType,
          input: (resolvedInput ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          status: 'running',
          startedAt: new Date(),
        },
      });

      try {
        const evidence = await this.actionsRegistry.execute(
          step.actionType,
          automation.organizationId,
          resolvedInput,
        );
        await this.prisma.automationStepRun.update({
          where: { id: stepRun.id },
          data: {
            status: 'succeeded',
            evidence: redactSensitive(evidence) as Prisma.InputJsonValue,
            finishedAt: new Date(),
          },
        });
      } catch (error) {
        const rawMessage =
          error instanceof Error ? error.message : String(error);
        const cleanedMessage = redactSensitive(rawMessage) as string;
        await this.prisma.automationStepRun.update({
          where: { id: stepRun.id },
          data: {
            status: 'failed',
            error: cleanedMessage,
            finishedAt: new Date(),
          },
        });
        return this.finishRun(run.id, 'failed', cleanedMessage);
      }
    }

    return this.finishRun(run.id, 'succeeded');
  }

  private async finishRun(
    runId: string,
    status: 'succeeded' | 'failed',
    errorMessage?: string,
  ): Promise<AutomationRunWithSteps> {
    return this.prisma.automationRun.update({
      where: { id: runId },
      data: {
        status,
        errorMessage: errorMessage ?? null,
        finishedAt: new Date(),
      },
      include: { steps: { orderBy: { sequence: 'asc' } } },
    });
  }

  // ---------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------

  private validateTrigger(trigger: AutomationTriggerDto) {
    if (trigger.type === 'scheduled' && !trigger.cronExpression) {
      throw new AutomationValidationError(
        'A scheduled trigger requires a cronExpression.',
      );
    }
    if (trigger.type === 'event' && !trigger.eventType) {
      throw new AutomationValidationError(
        'An event trigger requires an eventType.',
      );
    }
  }

  private validateSteps(steps: AutomationStepDto[]) {
    if (!steps || steps.length === 0) {
      throw new AutomationValidationError(
        'An automation needs at least one step.',
      );
    }
    if (steps.length > MAX_STEPS_PER_AUTOMATION) {
      throw new AutomationTooManyStepsError(MAX_STEPS_PER_AUTOMATION);
    }
    for (const step of steps) {
      if (!this.actionsRegistry.isAllowed(step.actionType)) {
        throw new AutomationValidationError(
          `Action type "${step.actionType}" is not in the Ops action allowlist.`,
        );
      }
    }
  }

  private validateConditions(conditions: ConditionNode | null | undefined) {
    if (!conditions) return;
    try {
      validateConditionTree(conditions);
    } catch (error) {
      if (error instanceof InvalidConditionError) {
        throw new AutomationValidationError(error.message);
      }
      throw error;
    }
  }
}
