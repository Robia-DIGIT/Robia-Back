import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditRunnerService } from './audit-runner/audit-runner.service';
//import { Prisma } from '@prisma/client';

@Injectable()
export class AuditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditRunner: AuditRunnerService,
  ) {}

  async run(organizationId: string, websiteId: string) {
    const website = await this.prisma.website.findFirst({
      where: { id: websiteId, organizationId },
    });

    if (!website) {
      throw new NotFoundException(
        "Aucun site connecté. Connectez d'abord votre site avant de lancer un audit.",
      );
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { city: true},
    });

    const audit = await this.prisma.audit.create({
      data: {
        organizationId,
        websiteId: website.id,
        status: 'running',
      },
    });

    // Exécution "synchrone" pour le MVP (pas de queue async pour l'instant)
    try {
      const result = await this.auditRunner.runAudit(
        website.url,
        organization?.city,
      );

      return this.prisma.audit.update({
        where: { id: audit.id },
        data: {
          status: 'completed',
          globalScore: result.global_score,
          //resultJson: result as Prisma.InputJsonValue,
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

  async findLatestForWebsite(organizationId: string, websiteId: string) {
    const audit = await this.prisma.audit.findFirst({
      where: { organizationId, websiteId },
      orderBy: { createdAt: 'desc' },
    });

    if (!audit) {
      throw new NotFoundException('Aucun audit trouvé pour cette organisation');
    }

    return audit;
  }

  async findAllForWebsite(organizationId: string, websiteId: string) {
    return this.prisma.audit.findMany({
      where: { organizationId, websiteId },
      orderBy: { createdAt: 'desc' },
    });
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