import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditsService } from '../../audits/audits.service';
import { OpportunitiesService } from '../../opportunities/opportunities.service';

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
  | 'robia.action_items.create_internal_task';

export type OpsActionInput = Record<string, unknown>;
export type OpsActionEvidence = Record<string, unknown>;

export class UnknownOpsActionError extends Error {}
export class InvalidOpsActionInputError extends Error {}

interface OpsActionDescriptor {
  type: OpsActionType;
  description: string;
  execute: (
    organizationId: string,
    input: OpsActionInput | null | undefined,
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
  ) {
    const registered = [
      this.buildRunDiagnostic(),
      this.buildRegenerateOpportunities(),
      this.buildPrepareOrganizationSummary(),
      this.buildCreateInternalTask(),
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

  async execute(
    actionType: string,
    organizationId: string,
    input: OpsActionInput | null | undefined,
  ): Promise<OpsActionEvidence> {
    const action = this.actions.get(actionType as OpsActionType);
    if (!action) {
      throw new UnknownOpsActionError(
        `Action type "${actionType}" is not in the Ops action allowlist.`,
      );
    }
    return action.execute(organizationId, input);
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
}
