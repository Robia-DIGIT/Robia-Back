import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditsService } from '../../audits/audits.service';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { maskEmail } from '../../notifications/mask-email';

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
  | 'robia.notification.send_email';

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
  ) {
    const registered = [
      this.buildRunDiagnostic(),
      this.buildRegenerateOpportunities(),
      this.buildPrepareOrganizationSummary(),
      this.buildCreateInternalTask(),
      this.buildSendEmail(),
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
        const { delivery, recipientEmail } =
          await this.notifications.createEmailDelivery({
            organizationId,
            automationId: context.automationId,
            automationRunId: context.runId,
            automationStepRunId: context.stepRunId,
            templateKey,
            templateData,
            auditId,
          });
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
}
