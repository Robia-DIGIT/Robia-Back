import { Injectable, NotFoundException } from '@nestjs/common';
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
    const opportunity = await this.prisma.opportunity.findFirst({
      where: { id: dto.opportunityId, organizationId },
    });

    if (!opportunity) {
      throw new NotFoundException('Opportunité non trouvée');
    }

    const generated = await this.generator.generate(
      dto.type,
      opportunity.title,
      opportunity.description,
    );

    return this.prisma.document.create({
      data: {
        organizationId,
        opportunityId: opportunity.id,
        type: dto.type,
        title: generated.title,
        content: generated.content,
        status: 'draft',
      },
    });
  }

  async findAllByOpportunity(organizationId: string, opportunityId: string) {
    return this.prisma.document.findMany({
      where: { organizationId, opportunityId },
      orderBy: { createdAt: 'desc' },
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
    await this.findOne(organizationId, documentId); // vérifie l'appartenance

    return this.prisma.document.update({
      where: { id: documentId },
      data: {
        content: dto.content,
        status: 'edited',
      },
    });
  }
}
