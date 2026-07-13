import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateValidationLogDto } from './dto/create-validation-log.dto';

@Injectable()
export class ValidationLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    organizationId: string,
    userId: string,
    dto: CreateValidationLogDto,
  ) {
    const document = await this.prisma.document.findFirst({
      where: { id: dto.documentId, organizationId },
    });

    if (!document) {
      throw new NotFoundException('Document non trouvé pour cette organisation');
    }

    const validationLog = await this.prisma.validationLog.create({
      data: {
        organizationId,
        userId,
        documentId: document.id,
        actionType: dto.actionType,
        platform: dto.platform,
        beforeValue: null, // MVP : pas de valeur "avant" externe encore trackée
        afterValue: document.content,
        status: dto.status,
        validatedAt: new Date(),
      },
    });

    // Si approuvé, on marque le document comme "validated"
    if (dto.status === 'approved') {
      await this.prisma.document.update({
        where: { id: document.id },
        data: { status: 'validated' },
      });
    }

    return validationLog;
  }

  async findAll(organizationId: string) {
    return this.prisma.validationLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }
}