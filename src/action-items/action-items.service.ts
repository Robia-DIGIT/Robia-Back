import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActionGeneratorService } from './action-generator/action-generator.service';
import { UpdateActionStatusDto } from './dto/update-action-status.dto';

@Injectable()
export class ActionItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: ActionGeneratorService,
  ) {}

  async generateFromOpportunity(
    organizationId: string,
    opportunityId: string,
  ) {
    const opportunity = await this.prisma.opportunity.findFirst({
      where: { id: opportunityId, organizationId },
    });

    if (!opportunity) {
      throw new NotFoundException('Opportunité non trouvée');
    }

    const generated = await this.generator.generateFromOpportunity(
      opportunity.title,
    );

    return this.prisma.$transaction(
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
  }

  async findAll(organizationId: string) {
    return this.prisma.actionItem.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
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

    return this.prisma.actionItem.update({
      where: { id: actionId },
      data: { status: dto.status },
    });
  }

  async getActionsForExport(organizationId: string) {
    return this.prisma.actionItem.findMany({
      where: { organizationId },
        orderBy: { createdAt: 'desc' },
        select: { title: true, status: true, dueDate: true },
  });
  }
}