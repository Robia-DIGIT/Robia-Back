import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RejectActionDto } from './dto/reject-action.dto';
import { RecordActionExecutionDto } from './dto/record-action-execution.dto';

@Injectable()
export class ActionExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  private async action(organizationId: string, actionId: string) {
    const action = await this.prisma.actionItem.findFirst({
      where: { id: actionId, organizationId },
    });
    if (!action) {
      throw new NotFoundException('Action non trouvée');
    }
    return action;
  }

  private eventKey(actionId: string, type: string) {
    return `${actionId}:${type}:${randomUUID()}`;
  }

  async submit(organizationId: string, userId: string, actionId: string) {
    const action = await this.action(organizationId, actionId);
    if (action.approvalStatus === 'pending') {
      return { action, changed: false };
    }
    if (action.approvalStatus === 'approved') {
      throw new BadRequestException('Action déjà approuvée');
    }

    const [updated, event] = await this.prisma.$transaction([
      this.prisma.actionItem.update({
        where: { id: action.id },
        data: {
          approvalStatus: 'pending',
          approvalReason: null,
          executionStatus: 'not_started',
        },
      }),
      this.prisma.actionExecutionEvent.create({
        data: {
          organizationId,
          actionItemId: action.id,
          userId,
          eventType: 'submitted',
          idempotencyKey: this.eventKey(action.id, 'submitted'),
        },
      }),
    ]);

    return { action: updated, event, changed: true };
  }

  async approve(organizationId: string, userId: string, actionId: string) {
    const action = await this.action(organizationId, actionId);
    if (action.approvalStatus === 'approved') {
      return { action, changed: false };
    }
    if (action.approvalStatus !== 'pending') {
      throw new BadRequestException(
        'Une action doit être soumise avant approbation',
      );
    }

    const [updated, event] = await this.prisma.$transaction([
      this.prisma.actionItem.update({
        where: { id: action.id },
        data: {
          approvalStatus: 'approved',
          approvalReason: null,
          executionStatus: 'ready',
        },
      }),
      this.prisma.actionExecutionEvent.create({
        data: {
          organizationId,
          actionItemId: action.id,
          userId,
          eventType: 'approved',
          idempotencyKey: this.eventKey(action.id, 'approved'),
        },
      }),
    ]);

    return { action: updated, event, changed: true };
  }

  async reject(
    organizationId: string,
    userId: string,
    actionId: string,
    dto: RejectActionDto,
  ) {
    const action = await this.action(organizationId, actionId);
    if (action.approvalStatus !== 'pending') {
      throw new BadRequestException(
        'Seule une action en attente peut être rejetée',
      );
    }

    const reason = dto.reason.trim();
    const [updated, event] = await this.prisma.$transaction([
      this.prisma.actionItem.update({
        where: { id: action.id },
        data: {
          approvalStatus: 'rejected',
          approvalReason: reason,
          executionStatus: 'not_started',
        },
      }),
      this.prisma.actionExecutionEvent.create({
        data: {
          organizationId,
          actionItemId: action.id,
          userId,
          eventType: 'rejected',
          idempotencyKey: this.eventKey(action.id, 'rejected'),
          payload: { reason },
        },
      }),
    ]);

    return { action: updated, event, changed: true };
  }

  async recordExecution(
    organizationId: string,
    userId: string,
    actionId: string,
    dto: RecordActionExecutionDto,
  ) {
    const action = await this.action(organizationId, actionId);
    if (action.approvalStatus !== 'approved') {
      throw new BadRequestException(
        "L'action doit être approuvée avant toute exécution",
      );
    }

    const idempotencyKey = `${action.id}:execution:${dto.idempotencyKey.trim()}`;
    const existing = await this.prisma.actionExecutionEvent.findFirst({
      where: { organizationId, actionItemId: action.id, idempotencyKey },
    });
    if (existing) {
      return { action, event: existing, idempotent: true };
    }
    if (action.executionStatus === 'succeeded') {
      throw new BadRequestException('Action déjà exécutée avec succès');
    }

    const evidence = dto.evidence ?? {};
    if (dto.outcome === 'succeeded' && Object.keys(evidence).length === 0) {
      throw new BadRequestException("Une preuve d'exécution est requise");
    }
    if (dto.outcome === 'failed' && !dto.note?.trim()) {
      throw new BadRequestException("Une note d'erreur est requise");
    }

    if (dto.verificationAuditId) {
      const audit = await this.prisma.audit.findFirst({
        where: { id: dto.verificationAuditId, organizationId },
        select: { id: true },
      });
      if (!audit) {
        throw new NotFoundException(
          'Audit de vérification non trouvé pour cette organisation',
        );
      }
    }

    const payload: Prisma.InputJsonObject = {
      outcome: dto.outcome,
      evidence: evidence as Prisma.InputJsonValue,
      note: dto.note?.trim() ?? null,
      verificationAuditId: dto.verificationAuditId ?? null,
    };
    const [updated, event] = await this.prisma.$transaction([
      this.prisma.actionItem.update({
        where: { id: action.id },
        data: {
          status: dto.outcome === 'succeeded' ? 'done' : 'blocked',
          executionStatus: dto.outcome,
          executionEvidence: evidence as Prisma.InputJsonValue,
          verificationAuditId: dto.verificationAuditId ?? null,
          attemptCount: { increment: 1 },
        },
      }),
      this.prisma.actionExecutionEvent.create({
        data: {
          organizationId,
          actionItemId: action.id,
          userId,
          eventType:
            dto.outcome === 'succeeded'
              ? 'execution_succeeded'
              : 'execution_failed',
          idempotencyKey,
          payload,
        },
      }),
    ]);

    return { action: updated, event, idempotent: false };
  }

  async history(organizationId: string, actionId: string) {
    await this.action(organizationId, actionId);
    return this.prisma.actionExecutionEvent.findMany({
      where: { organizationId, actionItemId: actionId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
