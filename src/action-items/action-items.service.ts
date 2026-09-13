import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActionGeneratorService } from './action-generator/action-generator.service';
import { UpdateActionStatusDto } from './dto/update-action-status.dto';

type JsonRecord = Record<string, unknown>;

interface OpportunityContext {
  id: string;
  impactScore?: number | null;
  sourceData?: unknown;
}

// Mirrors the ActionItem Prisma model (prisma/schema.prisma) rather than
// importing Prisma's generated type directly: enrichAction/enrichActions
// spread the whole row into their return value (...action), so every real
// column needs to be named here for that spread — and for what downstream
// callers (e.g. getActionsForExport) read off the enriched result — to stay
// typed instead of falling back to an inferred error/any type. `opportunity`
// is additionally optional: only findAll's include: {opportunity: {...}} row
// shape carries it.
interface RawActionItem {
  id: string;
  organizationId: string;
  opportunityId: string | null;
  documentId: string | null;
  title: string;
  status: string;
  dueDate: Date | null;
  createdAt: Date;
  opportunity?: OpportunityContext | null;
}

@Injectable()
export class ActionItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: ActionGeneratorService,
  ) {}

  private asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonRecord)
      : {};
  }

  private stringList(value: unknown): string[] {
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  }

  private priorityLabel(severity: unknown): string {
    switch (severity) {
      case 'critical':
        return 'Critique';
      case 'high':
        return 'Haute';
      case 'medium':
        return 'Moyenne';
      case 'low':
        return 'Faible';
      default:
        return 'À qualifier';
    }
  }

  private enrichAction(
    action: RawActionItem,
    opportunity: OpportunityContext,
    sequence: number,
  ) {
    const source = this.asRecord(opportunity.sourceData);
    const evidence = Array.isArray(source.evidence) ? source.evidence : [];
    const affectedUrls = this.stringList(source.affectedUrls);
    const expected = evidence
      .map((item) => this.asRecord(item).expected)
      .filter(
        (item): item is string =>
          typeof item === 'string' && Boolean(item.trim()),
      );
    const summary =
      typeof source.summary === 'string' && source.summary.trim()
        ? source.summary.trim()
        : typeof source.whyItMatters === 'string'
          ? source.whyItMatters.trim()
          : '';
    const priorityScore =
      typeof source.priorityScore === 'number'
        ? source.priorityScore
        : (opportunity.impactScore ?? 0);

    return {
      ...action,
      opportunity: undefined,
      priority: this.priorityLabel(source.severity),
      priorityScore,
      sequence,
      description: summary || undefined,
      affectedUrls,
      evidence,
      validationCriteria:
        expected.length > 0
          ? `Relancer l'audit et vérifier : ${[...new Set(expected)].join(' ; ')}`
          : "Vérifier manuellement la correction avant de terminer l'action.",
    };
  }

  private enrichActions(
    actions: RawActionItem[],
    fallbackOpportunity?: OpportunityContext,
  ) {
    const enriched = actions.map((action) => {
      const opportunity = action.opportunity ??
        fallbackOpportunity ?? { id: String(action.opportunityId ?? '') };
      const source = this.asRecord(opportunity.sourceData);
      const recommendedSteps = this.stringList(source.recommendedSteps);
      const stepIndex = recommendedSteps.indexOf(String(action.title ?? ''));

      return {
        value: this.enrichAction(
          action,
          opportunity,
          stepIndex >= 0 ? stepIndex + 1 : 999,
        ),
        opportunityId: opportunity.id,
        stepIndex,
        createdAt: action.createdAt ? new Date(action.createdAt).getTime() : 0,
      };
    });

    enriched.sort((left, right) => {
      const priorityDifference =
        Number(right.value.priorityScore) - Number(left.value.priorityScore);
      if (priorityDifference !== 0) return priorityDifference;
      if (left.opportunityId !== right.opportunityId) {
        return left.opportunityId.localeCompare(right.opportunityId);
      }
      if (left.stepIndex >= 0 || right.stepIndex >= 0) {
        return (
          (left.stepIndex < 0 ? 999 : left.stepIndex) -
          (right.stepIndex < 0 ? 999 : right.stepIndex)
        );
      }
      return left.createdAt - right.createdAt;
    });

    let currentOpportunityId = '';
    let sequence = 0;
    return enriched.map((item) => {
      if (item.opportunityId !== currentOpportunityId) {
        currentOpportunityId = item.opportunityId;
        sequence = 1;
      } else {
        sequence += 1;
      }
      return { ...item.value, sequence };
    });
  }

  async generateFromOpportunity(organizationId: string, opportunityId: string) {
    const opportunity = await this.prisma.opportunity.findFirst({
      where: { id: opportunityId, organizationId },
    });

    if (!opportunity) {
      throw new NotFoundException('Opportunité non trouvée');
    }

    const existing = await this.prisma.actionItem.findMany({
      where: { organizationId, opportunityId: opportunity.id },
      orderBy: { createdAt: 'asc' },
    });

    if (existing.length > 0) {
      return this.enrichActions(existing, opportunity);
    }

    const source = this.asRecord(opportunity.sourceData);
    const recommendedSteps = this.stringList(source.recommendedSteps);
    const generated =
      Number(source.version) === 2 && recommendedSteps.length > 0
        ? recommendedSteps.map((title) => ({ title }))
        : await this.generator.generateFromOpportunity(
            opportunity.title,
            opportunity.description,
          );

    const created = await this.prisma.$transaction(
      generated.map((action) =>
        this.prisma.actionItem.create({
          data: {
            organizationId,
            opportunityId: opportunity.id,
            title: action.title,
            status: 'todo',
          },
        }),
      ),
    );

    return this.enrichActions(created, opportunity);
  }

  async findAll(organizationId: string, websiteId?: string) {
    let auditId: string | undefined;

    if (websiteId) {
      const latestAudit = await this.prisma.audit.findFirst({
        where: { organizationId, websiteId, status: 'completed' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (!latestAudit) return [];
      auditId = latestAudit.id;
    }

    const actions = await this.prisma.actionItem.findMany({
      where: {
        organizationId,
        ...(auditId ? { opportunity: { auditId } } : {}),
      },
      include: {
        opportunity: {
          select: { id: true, impactScore: true, sourceData: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return this.enrichActions(actions);
  }

  async updateStatus(
    organizationId: string,
    actionId: string,
    dto: UpdateActionStatusDto,
  ) {
    const action = await this.prisma.actionItem.findFirst({
      where: { id: actionId, organizationId },
    });

    if (!action) {
      throw new NotFoundException('Action non trouvée');
    }

    const updated = await this.prisma.actionItem.update({
      where: { id: actionId },
      data: { status: dto.status },
    });

    const opportunity = action.opportunityId
      ? await this.prisma.opportunity.findFirst({
          where: { id: action.opportunityId, organizationId },
          select: { id: true, impactScore: true, sourceData: true },
        })
      : null;

    return this.enrichAction(
      updated,
      opportunity ?? { id: String(action.opportunityId) },
      1,
    );
  }

  async getActionsForExport(organizationId: string, websiteId?: string) {
    const actions = await this.findAll(organizationId, websiteId);
    return actions.map((action) => ({
      title: action.title,
      status: action.status,
      dueDate: action.dueDate,
    }));
  }

  async generatePlan(organizationId: string) {
    const actions = await this.prisma.actionItem.findMany({
      where: { organizationId, status: 'todo', dueDate: null },
      include: {
        opportunity: {
          select: { impactScore: true, effortScore: true },
        },
      },
    });

    if (actions.length === 0) {
      return [];
    }

    const sorted = actions.sort((a, b) => {
      const scoreA =
        (a.opportunity?.impactScore ?? 5) - (a.opportunity?.effortScore ?? 3);
      const scoreB =
        (b.opportunity?.impactScore ?? 5) - (b.opportunity?.effortScore ?? 3);
      return scoreB - scoreA;
    });

    const daysSpan = 30;
    const intervalDays = Math.max(1, Math.floor(daysSpan / sorted.length));

    const updates = sorted.map((action, index) => {
      const dueDate = new Date();
      dueDate.setDate(
        dueDate.getDate() + Math.min(index * intervalDays, daysSpan),
      );

      return this.prisma.actionItem.update({
        where: { id: action.id },
        data: { dueDate },
      });
    });

    return this.prisma.$transaction(updates);
  }

  async updateDueDate(organizationId: string, actionId: string, dueDate: Date) {
    const action = await this.prisma.actionItem.findFirst({
      where: { id: actionId, organizationId },
    });

    if (!action) {
      throw new NotFoundException('Action non trouvée');
    }

    return this.prisma.actionItem.update({
      where: { id: actionId },
      data: { dueDate },
    });
  }
}
