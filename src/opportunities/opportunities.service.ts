import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OpportunityGeneratorService } from './opportunity-generator/opportunity-generator.service';

@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: OpportunityGeneratorService,
  ) {}

  async generateFromLatestAudit(organizationId: string) {
    const audit = await this.prisma.audit.findFirst({
      where: { organizationId, status: 'completed' },
      orderBy: { createdAt: 'desc' },
    });

    if (!audit) {
      throw new NotFoundException(
        "Aucun audit terminé trouvé. Lancez d'abord un audit avant de générer des opportunités.",
      );
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { city: true },
    });

    const generated = await this.generator.generate(
      audit.resultJson as Record<string, any>,
      organization?.city,
    );

    // On supprime les anciennes opportunités liées à cet audit avant d'en générer de nouvelles
    // (évite l'accumulation si on relance la génération plusieurs fois sur le même audit)
    await this.prisma.opportunity.deleteMany({
      where: { auditId: audit.id },
    });

    const created = await this.prisma.$transaction(
      generated.map((opp) =>
        this.prisma.opportunity.create({
          data: {
            organizationId,
            auditId: audit.id,
            title: opp.title,
            description: opp.description,
            category: opp.category,
            impactScore: opp.impact_score,
            effortScore: opp.effort_score,
            confidenceScore: opp.confidence_score,
            sourceData: opp.source_data,
            status: 'open',
          },
        }),
      ),
    );

    return created;
  }

  async findAll(organizationId: string) {
    return this.prisma.opportunity.findMany({
      where: { organizationId },
      orderBy: { impactScore: 'desc' },
      take: 5,
    });
  }

  async findOne(organizationId: string, opportunityId: string) {
    const opportunity = await this.prisma.opportunity.findFirst({
      where: { id: opportunityId, organizationId },
    });

    if (!opportunity) {
      throw new NotFoundException('Opportunité non trouvée');
    }

    return opportunity;
  }
}