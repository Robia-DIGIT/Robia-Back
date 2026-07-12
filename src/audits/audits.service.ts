import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditRunnerService } from './audit-runner/audit-runner.service';

@Injectable()
export class AuditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditRunner: AuditRunnerService,
  ) {}

  async run(organizationId: string) {
    const website = await this.prisma.website.findFirst({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });

    if (!website) {
      throw new NotFoundException(
        "Aucun site connecté. Connectez d'abord votre site avant de lancer un audit.",
      );
    }

    const audit = await this.prisma.audit.create({
      data: {
        organizationId,
        websiteId: website.id,
        status: 'running',
      },
    });

    // Exécution "synchrone" pour le MVP (pas de queue async pour l'instant)
    try {
      const result = await this.auditRunner.runAudit(website.url);

      return this.prisma.audit.update({
        where: { id: audit.id },
        data: {
          status: 'completed',
          globalScore: result.global_score,
          resultJson: result as any,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      return this.prisma.audit.update({
        where: { id: audit.id },
        data: {
          status: 'failed',
          errorMessage:
            error instanceof Error ? error.message : 'Erreur inconnue',
        },
      });
    }
  }

  async findLatest(organizationId: string) {
    const audit = await this.prisma.audit.findFirst({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });

    if (!audit) {
      throw new NotFoundException('Aucun audit trouvé pour cette organisation');
    }

    return audit;
  }

  async findOne(organizationId: string, auditId: string) {
    const audit = await this.prisma.audit.findFirst({
      where: { id: auditId, organizationId },
    });

    if (!audit) {
      throw new NotFoundException('Audit non trouvé');
    }

    return audit;
  }
}