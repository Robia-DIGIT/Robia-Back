import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
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
import {
  InvalidOpsActionInputError,
  OpsActionsRegistryService,
  UnknownOpsActionError,
} from './actions/ops-actions-registry.service';
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
  InvalidCronExpressionError,
  InvalidTimezoneError,
  computeNextOccurrence,
} from './cron-schedule';
import {
  AutomationRunWithSteps,
  AutomationWithTrigger,
  StoredAutomationStep,
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
  private readonly logger = new Logger(AutomationsService.name);

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

    const enabled = dto.enabled ?? false;
    const timezone = dto.trigger.timezone ?? 'UTC';
    const nextRunAt = this.resolveNextRunAt({
      enabled,
      triggerType: dto.trigger.type,
      cronExpression: dto.trigger.cronExpression ?? null,
      timezone,
    });

    return this.prisma.automation.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description ?? null,
        enabled,
        nextRunAt,
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
            timezone,
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
    const existing = await this.findOne(organizationId, id);

    if (dto.trigger) {
      this.validateTrigger(dto.trigger);
    }
    if (dto.steps) {
      this.validateSteps(dto.steps);
    }
    if (dto.conditions !== undefined) {
      this.validateConditions(dto.conditions);
    }

    // nextRunAt is always recomputed from the *effective* post-update state
    // (whatever isn't in this dto falls back to what's already stored),
    // never just when a specific field is detected as "the cron one" —
    // one code path, so it can't miss a case (enabled flipped, trigger
    // type changed away from scheduled, cron/timezone edited, ...) the way
    // a per-field conditional easily could.
    const effectiveEnabled = dto.enabled ?? existing.enabled;
    const effectiveTimezone =
      dto.trigger?.timezone ?? existing.trigger?.timezone ?? 'UTC';
    const nextRunAt = this.resolveNextRunAt({
      enabled: effectiveEnabled,
      triggerType: dto.trigger?.type ?? existing.trigger?.type ?? 'manual',
      cronExpression:
        dto.trigger?.cronExpression ?? existing.trigger?.cronExpression ?? null,
      timezone: effectiveTimezone,
    });

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
        nextRunAt,
        // RC-25 review fix: nextRunAt is always rewritten above (recomputed
        // from the effective post-update state), so any scheduler claim
        // that was in flight for the *previous* nextRunAt value is
        // necessarily stale the instant this commits — release it
        // immediately rather than waiting for the lease to time out. This
        // is what lets AutomationSchedulerService's own re-fetch
        // (fresh.nextRunAt === scheduledFor check) catch a disable/
        // re-enable or cron/timezone edit that lands between its claim and
        // that re-fetch: the claim it thinks it still holds is gone.
        scheduledClaimedAt: null,
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
                    timezone: effectiveTimezone,
                  },
                  update: {
                    type: dto.trigger.type,
                    cronExpression: dto.trigger.cronExpression ?? null,
                    eventType: dto.trigger.eventType ?? null,
                    timezone: effectiveTimezone,
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
    const existing = await this.findOne(organizationId, id);
    const nextRunAt = this.resolveNextRunAt({
      enabled,
      triggerType: existing.trigger?.type ?? 'manual',
      cronExpression: existing.trigger?.cronExpression ?? null,
      timezone: existing.trigger?.timezone ?? 'UTC',
    });
    return this.prisma.automation.update({
      where: { id },
      // RC-25 review fix: same reasoning as update() — nextRunAt is always
      // rewritten here (disabling clears it, re-enabling recomputes it), so
      // any in-flight scheduler claim for the previous value is stale the
      // instant this commits.
      data: { enabled, nextRunAt, scheduledClaimedAt: null },
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

  // Dedicated entry point for AutomationSchedulerService — deliberately not
  // just startRun() made public. The caller must already hold this
  // automation (having won the atomic nextRunAt claim for `scheduledFor`
  // — see AutomationSchedulerService.runDueAutomations()); this method
  // itself does no claiming, no re-fetch, and no org-scope check, only the
  // run-creation half of the contract. `scheduledFor` — the occurrence
  // that was actually due, never the newly-computed next one — is what
  // makes the dedupKey deterministic per occurrence, so two callers
  // racing for the *same* occurrence (if the claim step were ever bypassed)
  // still collapse to exactly one run via the existing
  // (organizationId, dedupKey) unique constraint (see persistRun()).
  async triggerScheduled(
    automation: AutomationWithTrigger,
    scheduledFor: Date,
  ): Promise<AutomationRunWithSteps> {
    return this.startRun(automation, {
      triggerType: 'scheduled',
      dedupKey: `automation:${automation.id}:scheduled:${scheduledFor.toISOString()}`,
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
    // getRun() is only for the org-scope check and the friendly 404/409
    // messages below — the actual approve decision is claimed atomically by
    // the conditional updateMany just after, never by this read.
    const run = await this.getRun(organizationId, runId);
    if (run.status !== 'waiting_approval') {
      throw new ConflictException("Ce run n'est pas en attente d'approbation.");
    }

    // Compare-and-swap: only a run still (status='waiting_approval',
    // approvalStatus='pending') at the moment this single UPDATE statement
    // runs gets claimed. Two concurrent approve calls — or an approve racing
    // a reject — can both pass the read above, but at most one of these
    // conditional updates ever matches a row: Postgres serializes concurrent
    // UPDATEs against the same row, and the loser's WHERE no longer matches
    // once the winner's write is visible. This is what actually prevents
    // double-execution and execute-after-reject, not the read above.
    const claim = await this.prisma.automationRun.updateMany({
      where: {
        id: run.id,
        organizationId,
        status: 'waiting_approval',
        approvalStatus: 'pending',
      },
      data: {
        approvalStatus: 'approved',
        approvedById: userId,
        approvalReason: reason ?? null,
        approvedAt: new Date(),
        status: 'running',
        startedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      throw new ConflictException("Ce run n'est pas en attente d'approbation.");
    }

    const approved = await this.getRun(organizationId, runId);
    return this.executeSteps(approved);
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

    // Same compare-and-swap as approveRun() — see the comment there. Rejected
    // means rejected: status goes straight to 'cancelled' and executeSteps()
    // is never called, and this claim can never succeed after an approve (or
    // another reject) has already won the race.
    const claim = await this.prisma.automationRun.updateMany({
      where: {
        id: run.id,
        organizationId,
        status: 'waiting_approval',
        approvalStatus: 'pending',
      },
      data: {
        approvalStatus: 'rejected',
        approvedById: userId,
        approvalReason: reason ?? null,
        approvedAt: new Date(),
        status: 'cancelled',
        finishedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      throw new ConflictException("Ce run n'est pas en attente d'approbation.");
    }

    return this.getRun(organizationId, runId);
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
        // Deterministic from the event's own identity *and* the automation
        // it belongs to: (organizationId, dedupKey) is the run's whole
        // identity, so a dedupKey shared across automations would make a
        // second matching automation collide with — and silently reuse —
        // the first automation's run instead of getting its own. Scoping by
        // automation.id keeps each automation's dedup independent while
        // still deduping a single automation's re-emissions of the same
        // event to exactly one run.
        dedupKey: `automation:${automation.id}:event:${event.id}`,
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
    // Scoped by (organizationId, eventType, eventKey) — never just eventKey:
    // an eventKey is only meant to be unique within its own type, so this
    // never returns a different event type's row (and its payload) for a
    // reused key.
    const existing = await this.prisma.automationEvent.findUnique({
      where: {
        organizationId_eventType_eventKey: {
          organizationId,
          eventType,
          eventKey,
        },
      },
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
          // Never trust the emitter: a payload can come from a future
          // integration webhook we don't control. Redact before this is
          // ever written to disk, the same way context/evidence/errors are.
          payload: (payload
            ? (redactSensitive(payload) as Prisma.InputJsonValue)
            : Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.automationEvent.findUnique({
          where: {
            organizationId_eventType_eventKey: {
              organizationId,
              eventType,
              eventKey,
            },
          },
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

    const rawSteps = readStoredSteps(automation.steps);
    if (rawSteps.length > MAX_STEPS_PER_AUTOMATION) {
      throw new AutomationTooManyStepsError(MAX_STEPS_PER_AUTOMATION);
    }

    // A {{event.<key>}} placeholder is resolved HERE, once, against the
    // triggering event's own already-persisted (redacted) payload — never
    // deferred to execution time. That is what makes plannedSteps a true
    // WYSIWYG plan: an approver reading `waiting_approval.plannedSteps` sees
    // the literal value ("audit-123") that will run, not a template string
    // ("{{event.auditId}}") that only resolves later. A manual/scheduled run
    // has no source event, so eventPayload stays null and any such
    // placeholder resolves to null, same as before.
    const sourceEvent = opts.sourceEventId
      ? await this.prisma.automationEvent.findUnique({
          where: { id: opts.sourceEventId },
        })
      : null;
    const eventPayload =
      (sourceEvent?.payload as Record<string, unknown> | null) ?? null;

    // Freeze the execution plan now, at trigger time: canonical (allowlisted
    // keys only), fully resolved action inputs, snapshotted before anything
    // about the automation can change underneath this run. executeSteps()
    // runs this snapshot verbatim — never the automation's live `steps`, and
    // never re-resolved — so an edit made while a run sits at
    // `waiting_approval` can never change what an approver's click actually
    // executes, and the plan an approver reads is exactly the plan that runs.
    let plannedSteps: StoredAutomationStep[];
    try {
      plannedSteps = rawSteps.map((step) => {
        const canonicalInput = this.actionsRegistry.canonicalizeInput(
          step.actionType,
          step.input,
        );
        const resolvedInput = resolveStepInput(canonicalInput, eventPayload);
        return {
          actionType: step.actionType,
          // resolveStepInput only ever replaces an existing key's own value
          // (see automation-templating.ts) so this can't introduce a new
          // key — re-canonicalizing here is a second, defensive pass, the
          // same way canonicalizeInput is called twice elsewhere in this
          // file, and it is what actually surfaces a placeholder that
          // resolved to null (a missing/absent event field) as a clean,
          // expected failure rather than a silently wrong stored value.
          input: this.actionsRegistry.canonicalizeInput(
            step.actionType,
            resolvedInput,
          ),
        };
      });
    } catch (error) {
      if (
        error instanceof InvalidOpsActionInputError ||
        error instanceof UnknownOpsActionError
      ) {
        // A {{event.*}} placeholder that resolved to null/absent — e.g. this
        // automation was triggered manually or by schedule but its steps
        // expect an event payload that doesn't exist. This is the same
        // "action's own input validation rejects it as a missing value"
        // outcome automation-templating.ts already documents, just caught
        // before a run is ever created rather than mid-execution.
        return this.persistRun(automation, opts, {
          status: 'failed',
          errorMessage: redactSensitive(error.message) as string,
          startedAt: new Date(),
          finishedAt: new Date(),
        });
      }
      throw error;
    }
    const plannedStepsJson = plannedSteps as unknown as Prisma.InputJsonValue;

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
        plannedSteps: plannedStepsJson,
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
        plannedSteps: plannedStepsJson,
      });
      return run;
    }

    const run = await this.persistRun(automation, opts, {
      status: 'running',
      context: sanitizedContext,
      plannedSteps: plannedStepsJson,
      startedAt: new Date(),
    });
    return this.executeSteps(run);
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
        // A P2002 that ISN'T the dedupKey race can only be the partial
        // unique index enforcing "at most one active run per automation"
        // (automation_runs_one_active_per_automation, see the migration) —
        // those are the only two unique constraints on this table. The
        // pre-check in startRun() is a fast, friendly failure path; this is
        // the actual DB-enforced guarantee, closing the check-then-create
        // race a plain findFirst() can never fully close on its own.
        throw new AutomationRunConflictError();
      }
      throw error;
    }
  }

  private async executeSteps(
    run: AutomationRunWithSteps,
  ): Promise<AutomationRunWithSteps> {
    // Never the automation's current `steps` — always this run's own frozen
    // plan (see startRun()), so an edit made after trigger time (in
    // particular, while a run sits at `waiting_approval`) can never change
    // what actually executes.
    const steps = readStoredSteps(run.plannedSteps);
    if (steps.length > MAX_STEPS_PER_AUTOMATION) {
      return this.finishRun(
        run.id,
        'failed',
        `Automation exceeds the maximum of ${MAX_STEPS_PER_AUTOMATION} steps.`,
      );
    }

    // Never re-resolve a {{event.<key>}} placeholder here: startRun() already
    // resolved every step's input against the triggering event's payload
    // before persisting plannedSteps, precisely so that what an approver
    // reads on a waiting_approval run IS the value that executes — re-doing
    // the resolution at this point would defeat that guarantee. This is the
    // final, already-canonical, already-resolved input, used verbatim.
    let sequence = 0;
    for (const step of steps) {
      sequence += 1;
      const resolvedInput = step.input;

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
          run.organizationId,
          resolvedInput,
          {
            automationId: run.automationId,
            runId: run.id,
            stepRunId: stepRun.id,
          },
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
    if (trigger.type === 'scheduled') {
      if (!trigger.cronExpression) {
        throw new AutomationValidationError(
          'A scheduled trigger requires a cronExpression.',
        );
      }
      // RC-25 review fix: reject incoherent combinations explicitly —
      // eventType only ever means something for an `event` trigger.
      // Silently accepting (and persisting) a stray eventType here would
      // let bad data through that later code has to defensively tolerate.
      if (trigger.eventType) {
        throw new AutomationValidationError(
          'A scheduled trigger cannot have an eventType.',
        );
      }
      // Validates both the cron expression and the timezone by actually
      // computing an occurrence with them — the same function used later
      // to compute the real nextRunAt, so "this trigger validated" and
      // "this trigger's nextRunAt can be computed" can never disagree.
      try {
        computeNextOccurrence(
          trigger.cronExpression,
          trigger.timezone ?? 'UTC',
          new Date(),
        );
      } catch (error) {
        if (
          error instanceof InvalidCronExpressionError ||
          error instanceof InvalidTimezoneError
        ) {
          throw new AutomationValidationError(error.message);
        }
        throw error;
      }
    } else if (trigger.type === 'event') {
      if (!trigger.eventType) {
        throw new AutomationValidationError(
          'An event trigger requires an eventType.',
        );
      }
      if (trigger.cronExpression) {
        throw new AutomationValidationError(
          'An event trigger cannot have a cronExpression.',
        );
      }
      if (trigger.timezone) {
        throw new AutomationValidationError(
          'An event trigger cannot have a timezone.',
        );
      }
    } else if (trigger.type === 'manual') {
      if (trigger.cronExpression) {
        throw new AutomationValidationError(
          'A manual trigger cannot have a cronExpression.',
        );
      }
      if (trigger.timezone) {
        throw new AutomationValidationError(
          'A manual trigger cannot have a timezone.',
        );
      }
      if (trigger.eventType) {
        throw new AutomationValidationError(
          'A manual trigger cannot have an eventType.',
        );
      }
    }
  }

  // The single place that decides what Automation.nextRunAt should be,
  // given the trigger/enabled state that will be persisted. Returns null
  // for every case that must never carry a scheduled nextRunAt: disabled,
  // manual, or event-triggered (see RC25 doc's "nextRunAt semantics").
  //
  // Assumes cronExpression/timezone already passed validateTrigger when
  // they were *written* — but this method also runs on every update/
  // setEnabled call that doesn't touch the trigger at all, using
  // `existing.trigger` data that could, in principle, predate this
  // validation (or a future bug). It must therefore never throw: a
  // computation failure here degrades to "can't schedule yet" (null) with
  // a logged warning, never a 500 on an unrelated field change (e.g.
  // renaming the automation).
  private resolveNextRunAt(params: {
    enabled: boolean;
    triggerType: string;
    cronExpression: string | null;
    timezone: string;
  }): Date | null {
    if (
      !params.enabled ||
      params.triggerType !== 'scheduled' ||
      !params.cronExpression
    ) {
      return null;
    }
    try {
      return computeNextOccurrence(
        params.cronExpression,
        params.timezone,
        new Date(),
      );
    } catch (error) {
      // RC-25 review fix: same redaction discipline as
      // AutomationSchedulerService's own error logs — never interpolate a
      // cron expression, timezone, or error message straight into a log
      // line without passing it through redactSensitive first.
      this.logger.warn(
        `Impossible de calculer nextRunAt (cron="${
          redactSensitive(params.cronExpression) as string
        }", timezone="${redactSensitive(params.timezone) as string}") : ${
          redactSensitive(
            error instanceof Error ? error.message : 'erreur inconnue',
          ) as string
        }`,
      );
      return null;
    }
  }

  // Mutates each step's `input` in place, replacing it with the action's own
  // canonical (allowlisted keys only) version — so whatever gets persisted
  // into Automation.steps can never carry a stray secret-shaped field
  // (a `token`/`apiKey` pasted into the wrong place, or anything else the
  // action itself never reads) through to storage or, later, execution.
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
      try {
        step.input = this.actionsRegistry.canonicalizeInput(
          step.actionType,
          step.input,
        );
      } catch (error) {
        if (
          error instanceof UnknownOpsActionError ||
          error instanceof InvalidOpsActionInputError
        ) {
          throw new AutomationValidationError(error.message);
        }
        throw error;
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
