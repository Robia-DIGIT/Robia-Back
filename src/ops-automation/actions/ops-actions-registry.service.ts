import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditsService } from '../../audits/audits.service';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { maskEmail } from '../../notifications/mask-email';
import { OdcApplicationsService } from '../../odc/odc-applications.service';

/**
 * RC-20 — the Ops action registry.
 *
 * This list *is* the allowlist. An Automation step names an `actionType`
 * string; nothing executes unless that exact string is a key in
 * `this.actions` below. There is deliberately no action here — and there
 * must never be one added — that runs an arbitrary shell command, an
 * arbitrary SQL query, an arbitrary outbound HTTP call, a GitHub merge, a
 * deploy, a destructive delete, or a Meta/GBP publish. Every action below
 * only reads or writes ROBIA's own, already-validated, organization-scoped
 * data through existing, already-tested services (AuditsService,
 * OpportunitiesService) or direct, organization-scoped Prisma calls —
 * never a caller-supplied URL, command, or query string.
 */

export type OpsActionType =
  | 'robia.audit.run_diagnostic'
  | 'robia.opportunities.regenerate'
  | 'robia.report.prepare_organization_summary'
  | 'robia.action_items.create_internal_task'
  | 'robia.notification.send_email'
  | 'robia.odc.prepare_application_summary'
  | 'robia.odc.flag_missing_documents'
  | 'robia.odc.create_review_task';

export type OpsActionInput = Record<string, unknown>;
export type OpsActionEvidence = Record<string, unknown>;

export class UnknownOpsActionError extends Error {}
export class InvalidOpsActionInputError extends Error {}

// RC-26 — trusted, server-resolved context passed alongside a step's own
// (caller-influenced) input. Never derived from anything a user supplies:
// automationId/runId/stepRunId always come from the real AutomationRun/
// AutomationStepRun rows executeSteps() just created. Only
// robia.notification.send_email reads this today; every other action
// ignores the extra parameter.
export interface OpsActionExecutionContext {
  automationId: string;
  runId: string;
  stepRunId: string;
}

interface OpsActionDescriptor {
  type: OpsActionType;
  description: string;
  // The exhaustive list of *string* input keys this action ever reads.
  // Anything else present on the caller-supplied input — a stray
  // `token`/`apiKey`, or any other extraneous field — is never persisted or
  // executed: see canonicalizeInput().
  inputSchema: string[];
  // RC-27 hardening — never defaulted, so registering a new action forces an
  // explicit choice. `true` only when replaying this action (the same
  // organizationId/input, executed again after the first attempt's outcome
  // is unknown — a crash, a stale claim) is provably harmless: either
  // read-only (no write at all), or idempotent by construction (a repeat
  // call converges to the same state rather than duplicating a side
  // effect). `false` is the safe default posture for everything else —
  // AutomationsService never auto-retries a step whose action is `false`
  // here, on any failure, transient-looking or not (see
  // step-retry-policy.ts's isPermanentStepError() vs. this: they answer
  // different questions — "was the error itself worth retrying" and "is
  // this action even safe to run twice" — and a step only actually retries
  // when both say yes).
  retrySafe: boolean;
  // Like inputSchema, but each field is only validated (as a non-empty
  // string) *if present* — never required. E.g. send_email's `auditId`,
  // which only some templates need.
  optionalInputSchema?: string[];
  // Additional keys that, when declared, must each be a plain JSON object
  // (defaulting to `{}` when absent) rather than a string — e.g.
  // send_email's `templateData`. Declared separately from inputSchema
  // because these are structured data, not a single string value.
  objectInputFields?: string[];
  execute: (
    organizationId: string,
    input: OpsActionInput | null | undefined,
    context?: OpsActionExecutionContext,
  ) => Promise<OpsActionEvidence>;
}

export interface OpsActionSummary {
  type: OpsActionType;
  description: string;
}

@Injectable()
export class OpsActionsRegistryService {
  private readonly actions: Map<OpsActionType, OpsActionDescriptor>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audits: AuditsService,
    private readonly opportunities: OpportunitiesService,
    private readonly notifications: NotificationsService,
    private readonly odcApplications: OdcApplicationsService,
  ) {
    const registered = [
      this.buildRunDiagnostic(),
      this.buildRegenerateOpportunities(),
      this.buildPrepareOrganizationSummary(),
      this.buildCreateInternalTask(),
      this.buildSendEmail(),
      this.buildOdcPrepareApplicationSummary(),
      this.buildOdcFlagMissingDocuments(),
      this.buildOdcCreateReviewTask(),
    ];
    this.actions = new Map(registered.map((action) => [action.type, action]));
  }

  listAllowedActions(): OpsActionSummary[] {
    return Array.from(this.actions.values()).map(({ type, description }) => ({
      type,
      description,
    }));
  }

  isAllowed(actionType: string): actionType is OpsActionType {
    return this.actions.has(actionType as OpsActionType);
  }

  // RC-27 hardening — see OpsActionDescriptor.retrySafe's own doc comment.
  // An unknown actionType is never retry-safe by definition (nothing here
  // ever executes it in the first place).
  isRetrySafe(actionType: string): boolean {
    return this.actions.get(actionType as OpsActionType)?.retrySafe ?? false;
  }

  /**
   * Validates the required fields for this action and returns a brand-new
   * object containing *only* the keys this action's schema declares —
   * anything else on `input` (a secret pasted into the wrong field, a stray
   * debug flag, whatever) is dropped, never copied through. Call this before
   * persisting a step definition/input and again before persisting or
   * executing a resolved step input: it is the single choke point that
   * guarantees nothing outside an action's own declared inputs ever reaches
   * storage or execution.
   */
  canonicalizeInput(
    actionType: string,
    input: OpsActionInput | null | undefined,
  ): OpsActionInput {
    const action = this.actions.get(actionType as OpsActionType);
    if (!action) {
      throw new UnknownOpsActionError(
        `Action type "${actionType}" is not in the Ops action allowlist.`,
      );
    }
    for (const field of action.inputSchema) {
      this.requireStringInput(input, field);
    }
    const canonical: OpsActionInput = {};
    for (const field of action.inputSchema) {
      canonical[field] = (input as OpsActionInput)[field];
    }
    for (const field of action.optionalInputSchema ?? []) {
      const value = input?.[field];
      if (value !== undefined && value !== null) {
        canonical[field] = this.requireStringInput(input, field);
      }
    }
    for (const field of action.objectInputFields ?? []) {
      canonical[field] = this.canonicalizeObjectInput(input, field);
    }
    return canonical;
  }

  async execute(
    actionType: string,
    organizationId: string,
    input: OpsActionInput | null | undefined,
    context?: OpsActionExecutionContext,
  ): Promise<OpsActionEvidence> {
    const action = this.actions.get(actionType as OpsActionType);
    if (!action) {
      throw new UnknownOpsActionError(
        `Action type "${actionType}" is not in the Ops action allowlist.`,
      );
    }
    return action.execute(organizationId, input, context);
  }

  // Validates and returns a declared object-typed field (e.g. send_email's
  // templateData): must be a plain object when present (never an array or
  // class instance), defaults to `{}` when absent — never required to be
  // non-empty, since some templates need no variables at all. Per-template
  // variable validation itself happens in notification-templates.ts, not
  // here: this is only structural hygiene, the same choke point that keeps
  // canonicalizeInput() the single place anything outside an action's own
  // declared inputs could ever leak through.
  private canonicalizeObjectInput(
    input: OpsActionInput | null | undefined,
    field: string,
  ): Record<string, unknown> {
    const value = input?.[field];
    if (value === undefined || value === null) {
      return {};
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new InvalidOpsActionInputError(
        `"${field}" must be a plain object.`,
      );
    }
    return { ...(value as Record<string, unknown>) };
  }

  private requireStringInput(
    input: OpsActionInput | null | undefined,
    field: string,
  ): string {
    const value = input?.[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidOpsActionInputError(
        `Missing or invalid "${field}" input.`,
      );
    }
    return value;
  }

  // "Diagnostic d'un site" — runs a fresh audit on a website already
  // connected to this organization. Never an arbitrary URL: AuditsService
  // resolves websiteId against `{ id, organizationId }` and rejects
  // anything not already registered to this org.
  private buildRunDiagnostic(): OpsActionDescriptor {
    return {
      type: 'robia.audit.run_diagnostic',
      description:
        "Lance un nouveau diagnostic (audit) sur un site déjà connecté à l'organisation.",
      // RC-27 hardening — AuditsService.run() creates a brand-new Audit row
      // on every call, with no dedup key of its own. Replaying this after a
      // crash of unknown outcome would risk a second, duplicate diagnostic
      // for the same trigger. Not retry-safe until it has its own
      // idempotency key (task explicitly names this one).
      retrySafe: false,
      inputSchema: ['websiteId'],
      execute: async (organizationId, input) => {
        const websiteId = this.requireStringInput(input, 'websiteId');
        const audit = await this.audits.run(organizationId, websiteId);
        return {
          auditId: audit.id,
          websiteId,
          status: audit.status,
          globalScore: audit.globalScore ?? null,
        };
      },
    };
  }

  // "Génération/régénération d'opportunités" — delegates entirely to
  // OpportunitiesService.generateFromAudit(), including its own idempotency
  // (RC-19): re-running this action on an audit that already has
  // opportunities never duplicates or deletes them.
  private buildRegenerateOpportunities(): OpsActionDescriptor {
    return {
      type: 'robia.opportunities.regenerate',
      description:
        'Génère ou complète les opportunités ROBIA (SEO + Meta) pour un audit déjà terminé.',
      // RC-27 hardening — OpportunitiesService.generateFromAudit() already
      // has its own idempotency (RC-19, see the doc comment just above this
      // descriptor): re-running it on an audit that already has
      // opportunities never duplicates or deletes them. Provably safe to
      // replay.
      retrySafe: true,
      inputSchema: ['auditId'],
      execute: async (organizationId, input) => {
        const auditId = this.requireStringInput(input, 'auditId');
        const opportunities = await this.opportunities.generateFromAudit(
          organizationId,
          auditId,
        );
        return {
          auditId,
          opportunityCount: opportunities.length,
          opportunityIds: opportunities.map(
            (opportunity: { id: string }) => opportunity.id,
          ),
        };
      },
    };
  }

  // "Préparation d'un rapport" — a read-only aggregate over this
  // organization's own data. No external call, no write.
  private buildPrepareOrganizationSummary(): OpsActionDescriptor {
    return {
      type: 'robia.report.prepare_organization_summary',
      description:
        "Prépare un résumé en lecture seule de l'organisation (sites, dernier audit, opportunités ouvertes, tâches en attente).",
      // RC-27 hardening — purely read-only (see the doc comment just above
      // this descriptor): no write at all, so replaying it can never
      // duplicate or corrupt anything.
      retrySafe: true,
      inputSchema: [],
      execute: async (organizationId) => {
        const [
          websiteCount,
          latestAudit,
          openOpportunityCount,
          pendingActionCount,
        ] = await Promise.all([
          this.prisma.website.count({ where: { organizationId } }),
          this.prisma.audit.findFirst({
            where: { organizationId, status: 'completed' },
            orderBy: { completedAt: 'desc' },
            select: {
              id: true,
              globalScore: true,
              completedAt: true,
              websiteId: true,
            },
          }),
          this.prisma.opportunity.count({
            where: { organizationId, status: 'open' },
          }),
          this.prisma.actionItem.count({
            where: { organizationId, status: 'todo' },
          }),
        ]);

        return {
          websiteCount,
          latestAudit: latestAudit
            ? {
                auditId: latestAudit.id,
                websiteId: latestAudit.websiteId,
                globalScore: latestAudit.globalScore ?? null,
                completedAt: latestAudit.completedAt,
              }
            : null,
          openOpportunityCount,
          pendingActionCount,
          generatedAt: new Date().toISOString(),
        };
      },
    };
  }

  // "Création d'une tâche interne" — a plain ActionItem, not linked to any
  // opportunity/document. Uses the model's own defaults
  // (approvalStatus: 'draft', executionStatus: 'not_started') — same RC-14
  // draft/approval lifecycle as every other ActionItem, no special-casing,
  // and nothing here ever transitions it further.
  private buildCreateInternalTask(): OpsActionDescriptor {
    return {
      type: 'robia.action_items.create_internal_task',
      description:
        'Crée une tâche ROBIA interne (ActionItem) en brouillon — jamais approuvée ni exécutée automatiquement.',
      // RC-27 hardening — creates a brand-new ActionItem row on every call,
      // no dedup key. Not retry-safe until it has its own idempotency key
      // (task explicitly names this one).
      retrySafe: false,
      inputSchema: ['title'],
      execute: async (organizationId, input) => {
        const title = this.requireStringInput(input, 'title');
        const actionItem = await this.prisma.actionItem.create({
          data: {
            organizationId,
            title,
            status: 'todo',
          },
        });
        return {
          actionItemId: actionItem.id,
          title: actionItem.title,
          approvalStatus: actionItem.approvalStatus,
          executionStatus: actionItem.executionStatus,
        };
      },
    };
  }

  // "Envoi d'un email de notification" — RC-26. Deliberately the most
  // restricted action in this registry:
  //   - templateKey must be one of NOTIFICATION_TEMPLATES' own keys
  //     (checked again, redundantly, by NotificationsService itself —
  //     never trust a single choke point for something this sensitive).
  //   - templateData carries only plain, size-bounded, allowlisted-per-
  //     template variables — never a subject, a body, or raw HTML.
  //   - the recipient is never part of the input at all: it is always
  //     Automation.createdById -> User.email, resolved server-side by
  //     NotificationsService from the trusted `context` this method
  //     receives (never from anything a caller-supplied `input` could
  //     influence) — there is no way to name an arbitrary address here.
  //   - no replyTo, no custom headers: NotificationTransport's own
  //     sendEmail() signature doesn't accept any.
  // Creating a NotificationDelivery here never sends anything by itself —
  // NotificationDispatcherService is the only thing that ever attempts the
  // actual send, on its own schedule.
  private buildSendEmail(): OpsActionDescriptor {
    return {
      type: 'robia.notification.send_email',
      description:
        "Crée une notification email (en attente d'envoi) à partir d'un template allowlisté, adressée exclusivement au créateur de l'automatisation.",
      // RC-27 hardening — safe to replay *only* because
      // NotificationsService.createEmailDelivery() dedups on a stable key
      // derived from automationStepRunId (see NotificationDelivery's own
      // `@@unique([organizationId, idempotencyKey])` and RC-26's doc
      // comment): a second call for the same step run always resolves to
      // the same NotificationDelivery row instead of creating a second
      // email. If that dedup key ever stopped being derived from
      // stepRunId, this would need to flip back to `false`.
      retrySafe: true,
      inputSchema: ['templateKey'],
      // `auditId` — required only by the `audit_completed` template (see
      // NotificationsService.resolveTemplateData()), which resolves its
      // own data (website URL, formatted score) from the real Audit
      // record rather than trusting templateData for those fields — the
      // real audit.completed event never carries a websiteUrl anyway (see
      // audit-completed.event.ts). Every other template ignores this
      // field.
      optionalInputSchema: ['auditId'],
      objectInputFields: ['templateData'],
      execute: async (organizationId, input, context) => {
        const templateKey = this.requireStringInput(input, 'templateKey');
        const templateData = (input as OpsActionInput)?.templateData ?? {};
        const auditId = (input as OpsActionInput)?.auditId as
          string | undefined;
        if (!context) {
          // Can only happen if this action is ever invoked outside
          // executeSteps() (it never is in this codebase) — fails loudly
          // rather than silently resolving no recipient.
          throw new InvalidOpsActionInputError(
            'robia.notification.send_email requires automation execution context.',
          );
        }
        const { delivery, recipientEmail, reason } =
          await this.notifications.createEmailDelivery({
            organizationId,
            automationId: context.automationId,
            automationRunId: context.runId,
            automationStepRunId: context.stepRunId,
            templateKey,
            templateData,
            auditId,
          });
        if (!delivery) {
          return { channel: 'email', templateKey, status: 'skipped', reason };
        }
        return {
          deliveryId: delivery.id,
          channel: delivery.channel,
          templateKey: delivery.templateKey,
          status: delivery.status,
          // Never the full address — see maskEmail()'s own doc comment.
          recipientMasked: maskEmail(recipientEmail),
        };
      },
    };
  }

  // RC-29 — "Résumé de candidature (IA)". Never generates a decision, never
  // touches `status`: only ever writes OdcApplication.summaryDraft, and only
  // ever from data already persisted on the application itself (no LLM call
  // exists in this codebase yet — see
  // OdcApplicationsService.prepareApplicationSummary()'s own doc comment). A
  // terminal application (accepted/rejected/withdrawn) is a silent no-op,
  // never an error: an automation racing a human decision must never fight
  // it or fail the run over it.
  private buildOdcPrepareApplicationSummary(): OpsActionDescriptor {
    return {
      type: 'robia.odc.prepare_application_summary',
      description:
        'Prépare un résumé (brouillon) pour une candidature ODC — ne change jamais son statut.',
      // RC-27 hardening — a pure, deterministic function of already-
      // persisted application data (see the doc comment just above this
      // descriptor): every call overwrites summaryDraft with the same
      // computed value given the same underlying state. Replaying it
      // converges, never duplicates or accumulates.
      retrySafe: true,
      inputSchema: ['applicationId'],
      execute: async (organizationId, input) => {
        const applicationId = this.requireStringInput(input, 'applicationId');
        const result = await this.odcApplications.prepareApplicationSummary(
          organizationId,
          applicationId,
        );
        return { applicationId, ...result };
      },
    };
  }

  // RC-29 — "Recalcul des pièces manquantes". Re-runs the exact same
  // deterministic completeness check submit() itself uses — never a
  // heuristic, never the AI. Only ever acts on a candidature currently
  // 'incomplete'; can move it to 'in_review' when now complete, never
  // straight to accepted/rejected/waitlisted (this action never even touches
  // those values — see OdcApplicationsService.recomputeMissingDocuments()).
  // A no-op on any other status.
  private buildOdcFlagMissingDocuments(): OpsActionDescriptor {
    return {
      type: 'robia.odc.flag_missing_documents',
      description:
        "Recalcule les pièces/champs manquants d'une candidature ODC en attente — peut passer 'incomplete' à 'in_review', jamais à une décision.",
      // RC-27 hardening — NOT idempotent despite converging to the same
      // status/missing state: OdcApplicationsService.recomputeMissingDocuments()
      // -> runScreening() unconditionally appends a new, append-only
      // OdcHistoryEvent (screening_passed/screening_failed) and re-emits a
      // domain event on *every* call, even when the recompute changes
      // nothing (still 'incomplete', same missing list). A replay after a
      // crash of unknown outcome would duplicate that history row and
      // could re-trigger whatever listens for the event a second time.
      retrySafe: false,
      inputSchema: ['applicationId'],
      execute: async (organizationId, input) => {
        const applicationId = this.requireStringInput(input, 'applicationId');
        const { changed, application } =
          await this.odcApplications.recomputeMissingDocuments(
            organizationId,
            applicationId,
          );
        return {
          applicationId,
          changed,
          status: application.status,
          missing: application.missing ?? null,
        };
      },
    };
  }

  // RC-29 — "Tâche de revue de candidature". A plain ActionItem, draft/
  // not_started via the model's own defaults — same posture as
  // robia.action_items.create_internal_task, never approved or executed
  // automatically. The title is always computed server-side from the
  // application's own applicant/program (see
  // OdcApplicationsService.createReviewTask()) — deliberately not a caller-
  // supplied field, so this action can never be used to write arbitrary
  // free text through an ActionItem title.
  private buildOdcCreateReviewTask(): OpsActionDescriptor {
    return {
      type: 'robia.odc.create_review_task',
      description:
        'Crée une tâche ROBIA interne de revue pour une candidature ODC — en brouillon, jamais approuvée automatiquement.',
      // RC-27 hardening — creates a brand-new ActionItem row on every call,
      // no dedup key, same class of bug as
      // robia.action_items.create_internal_task above. Not named
      // explicitly by the hardening spec, but the same "creates a fresh
      // row, no idempotency key" reasoning applies identically — the task's
      // stated policy ("only prove-idempotent or read-only actions may
      // replay") covers it regardless of whether it was named.
      retrySafe: false,
      inputSchema: ['applicationId'],
      execute: async (organizationId, input) => {
        const applicationId = this.requireStringInput(input, 'applicationId');
        const { actionItemId, title } =
          await this.odcApplications.createReviewTask(
            organizationId,
            applicationId,
          );
        return { applicationId, actionItemId, title };
      },
    };
  }
}
