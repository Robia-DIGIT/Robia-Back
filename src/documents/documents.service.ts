import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentGeneratorService } from './document-generator/document-generator.service';
import { GenerateDocumentDto } from './dto/generate-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: DocumentGeneratorService,
  ) {}

  async generate(organizationId: string, dto: GenerateDocumentDto) {
    if (!dto.opportunityId && !dto.websiteId) {
      throw new BadRequestException(
        'opportunityId ou websiteId est requis pour générer un contenu',
      );
    }

    const opportunity = dto.opportunityId
      ? await this.prisma.opportunity.findFirst({
          where: { id: dto.opportunityId, organizationId },
          include: { audit: { select: { websiteId: true } } },
        })
      : null;

    if (dto.opportunityId && !opportunity) {
      throw new NotFoundException('Opportunité non trouvée');
    }

    const websiteId = opportunity?.audit.websiteId ?? dto.websiteId;
    if (!websiteId) {
      throw new BadRequestException('Le site du contenu est requis');
    }
    if (dto.websiteId && dto.websiteId !== websiteId) {
      throw new BadRequestException(
        "L'opportunité n'appartient pas au site demandé",
      );
    }

    const website = await this.prisma.website.findFirst({
      where: { id: websiteId, organizationId },
      include: {
        organization: {
          select: {
            name: true,
            sector: true,
            city: true,
            country: true,
          },
        },
      },
    });
    if (!website) {
      throw new NotFoundException('Site non trouvé');
    }
    if (!opportunity && !dto.brief?.objective?.trim()) {
      throw new BadRequestException(
        'Un objectif est requis pour une génération libre',
      );
    }

    const action = dto.actionItemId
      ? await this.prisma.actionItem.findFirst({
          where: { id: dto.actionItemId, organizationId },
          select: { id: true, opportunityId: true },
        })
      : null;
    if (dto.actionItemId && !action) {
      throw new NotFoundException('Action non trouvée');
    }
    if (
      action?.opportunityId &&
      action.opportunityId !== (opportunity?.id ?? null)
    ) {
      throw new BadRequestException(
        "L'action et le contenu ne ciblent pas la même opportunité",
      );
    }

    const objective =
      dto.brief?.objective?.trim() || opportunity?.title || 'Contenu local';
    const description = opportunity?.description ?? objective;

    const generated = await this.generator.generate(
      dto.type,
      opportunity?.title ?? objective,
      description,
      {
        organizationName: website.organization.name,
        sector: website.organization.sector,
        city: website.organization.city,
        country: website.organization.country,
        websiteUrl: website.url,
        objective,
        audience: dto.brief?.audience?.trim(),
        tone: dto.brief?.tone?.trim(),
        locale: dto.brief?.locale?.trim(),
        userProvidedFacts:
          dto.brief?.facts?.map((fact) => fact.trim()).filter(Boolean) ?? [],
      },
    );

    const brief: Prisma.InputJsonValue | typeof Prisma.DbNull = dto.brief
      ? {
          ...(dto.brief.objective?.trim()
            ? { objective: dto.brief.objective.trim() }
            : {}),
          ...(dto.brief.audience?.trim()
            ? { audience: dto.brief.audience.trim() }
            : {}),
          ...(dto.brief.tone?.trim() ? { tone: dto.brief.tone.trim() } : {}),
          ...(dto.brief.locale?.trim()
            ? { locale: dto.brief.locale.trim() }
            : {}),
          facts:
            dto.brief.facts?.map((fact) => fact.trim()).filter(Boolean) ?? [],
        }
      : Prisma.DbNull;
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          organizationId,
          websiteId,
          opportunityId: opportunity?.id ?? null,
          type: dto.type,
          title: generated.title,
          content: generated.content,
          brief,
          status: 'draft',
        },
      });
      if (action) {
        const claimed = await tx.actionItem.updateMany({
          where: {
            id: action.id,
            organizationId,
            documentId: null,
          },
          data: { documentId: document.id },
        });
        if (claimed.count !== 1) {
          throw new ConflictException(
            'Cette action est déjà liée à un autre contenu',
          );
        }
      }
      return document;
    });
  }

  async findAll(
    organizationId: string,
    filters: { opportunityId?: string; websiteId?: string },
  ) {
    if (!filters.opportunityId && !filters.websiteId) {
      throw new BadRequestException('opportunity_id ou website_id est requis');
    }
    return this.prisma.document.findMany({
      where: {
        organizationId,
        ...(filters.opportunityId
          ? { opportunityId: filters.opportunityId }
          : {}),
        ...(filters.websiteId ? { websiteId: filters.websiteId } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
  }

  async findOne(organizationId: string, documentId: string) {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, organizationId },
    });

    if (!document) {
      throw new NotFoundException('Document non trouvé');
    }

    return document;
  }

  async update(
    organizationId: string,
    documentId: string,
    dto: UpdateDocumentDto,
  ) {
    const updated = await this.prisma.document.updateMany({
      where: {
        id: documentId,
        organizationId,
        revision: dto.expectedRevision,
      },
      data: {
        content: dto.content,
        status: 'edited',
        revision: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      const exists = await this.prisma.document.findFirst({
        where: { id: documentId, organizationId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Document non trouvé');
      throw new ConflictException(
        'Ce contenu a été modifié. Rechargez la dernière version avant de continuer.',
      );
    }
    return this.findOne(organizationId, documentId);
  }
}
