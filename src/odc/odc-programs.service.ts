import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOdcProgramDto } from './dto/create-odc-program.dto';
import { UpdateOdcProgramDto } from './dto/update-odc-program.dto';

export type OdcProgramWithDefinition = Prisma.OdcProgramGetPayload<{
  include: { fields: true; criteria: true; docTypes: true };
}>;

/**
 * RC-29 — program (appel à candidatures) lifecycle: draft -> open -> closed
 * -> archived, plus its definition (fields/criteria/docTypes). No route in
 * this RC ever deletes a program or reaches 'archived' (no archive endpoint
 * is specified) — see docs/RC29_ODC_CANDIDATURES.md's residual risks.
 */
@Injectable()
export class OdcProgramsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    organizationId: string,
    userId: string,
    dto: CreateOdcProgramDto,
  ): Promise<OdcProgramWithDefinition> {
    try {
      return await this.prisma.odcProgram.create({
        data: {
          organizationId,
          slug: dto.slug,
          name: dto.name,
          description: dto.description ?? null,
          opensAt: dto.opensAt ? new Date(dto.opensAt) : null,
          closesAt: dto.closesAt ? new Date(dto.closesAt) : null,
          requireDualReview: dto.requireDualReview ?? false,
          decisionThreshold: dto.decisionThreshold ?? null,
          createdById: userId,
          fields: { create: (dto.fields ?? []).map(toFieldCreateInput) },
          criteria: {
            create: (dto.criteria ?? []).map(toCriterionCreateInput),
          },
          docTypes: { create: (dto.docTypes ?? []).map(toDocTypeCreateInput) },
        },
        include: { fields: true, criteria: true, docTypes: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `A program with slug "${dto.slug}" already exists for this organization.`,
        );
      }
      throw error;
    }
  }

  async findAll(organizationId: string): Promise<OdcProgramWithDefinition[]> {
    return this.prisma.odcProgram.findMany({
      where: { organizationId },
      include: { fields: true, criteria: true, docTypes: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(
    organizationId: string,
    id: string,
  ): Promise<OdcProgramWithDefinition> {
    const program = await this.prisma.odcProgram.findFirst({
      where: { id, organizationId },
      include: { fields: true, criteria: true, docTypes: true },
    });
    if (!program) {
      throw new NotFoundException('Program non trouvé.');
    }
    return program;
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateOdcProgramDto,
  ): Promise<OdcProgramWithDefinition> {
    const existing = await this.findOne(organizationId, id);
    if (existing.status === 'archived') {
      throw new ConflictException('An archived program cannot be edited.');
    }

    // fields/criteria/docTypes are wholesale-replaced, never merged — see
    // UpdateOdcProgramDto's own doc comment. Only touched when the caller
    // actually sends that array, so a PATCH that only edits `name` never
    // clears the program's definition.
    await this.prisma.$transaction(async (tx) => {
      await tx.odcProgram.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.opensAt !== undefined
            ? { opensAt: dto.opensAt ? new Date(dto.opensAt) : null }
            : {}),
          ...(dto.closesAt !== undefined
            ? { closesAt: dto.closesAt ? new Date(dto.closesAt) : null }
            : {}),
          ...(dto.requireDualReview !== undefined
            ? { requireDualReview: dto.requireDualReview }
            : {}),
          ...(dto.decisionThreshold !== undefined
            ? { decisionThreshold: dto.decisionThreshold }
            : {}),
        },
      });

      if (dto.fields !== undefined) {
        await tx.odcField.deleteMany({ where: { programId: id } });
        if (dto.fields.length > 0) {
          await tx.odcField.createMany({
            data: dto.fields.map((field) => ({
              programId: id,
              ...toFieldCreateInput(field),
            })),
          });
        }
      }
      if (dto.criteria !== undefined) {
        await tx.odcCriterion.deleteMany({ where: { programId: id } });
        if (dto.criteria.length > 0) {
          await tx.odcCriterion.createMany({
            data: dto.criteria.map((criterion) => ({
              programId: id,
              ...toCriterionCreateInput(criterion),
            })),
          });
        }
      }
      if (dto.docTypes !== undefined) {
        await tx.odcDocumentType.deleteMany({ where: { programId: id } });
        if (dto.docTypes.length > 0) {
          await tx.odcDocumentType.createMany({
            data: dto.docTypes.map((docType) => ({
              programId: id,
              ...toDocTypeCreateInput(docType),
            })),
          });
        }
      }
    });

    return this.findOne(organizationId, id);
  }

  async open(
    organizationId: string,
    id: string,
  ): Promise<OdcProgramWithDefinition> {
    const program = await this.findOne(organizationId, id);
    if (program.status !== 'draft' && program.status !== 'closed') {
      throw new ConflictException(
        `Cannot open a program in status "${program.status}" — only "draft" or "closed" can open.`,
      );
    }
    await this.prisma.odcProgram.update({
      where: { id },
      data: { status: 'open' },
    });
    return this.findOne(organizationId, id);
  }

  async close(
    organizationId: string,
    id: string,
  ): Promise<OdcProgramWithDefinition> {
    const program = await this.findOne(organizationId, id);
    if (program.status !== 'open') {
      throw new ConflictException(
        `Cannot close a program in status "${program.status}" — only "open" can close.`,
      );
    }
    await this.prisma.odcProgram.update({
      where: { id },
      data: { status: 'closed' },
    });
    return this.findOne(organizationId, id);
  }
}

function toFieldCreateInput(field: {
  key: string;
  label: string;
  required?: boolean;
  fieldType: string;
  options?: unknown;
  sortOrder?: number;
}) {
  return {
    key: field.key,
    label: field.label,
    required: field.required ?? false,
    fieldType: field.fieldType,
    options: (field.options ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    sortOrder: field.sortOrder ?? 0,
  };
}

function toCriterionCreateInput(criterion: {
  key: string;
  label: string;
  description?: string;
  weight?: number;
  maxPoints?: number;
  required?: boolean;
  sortOrder?: number;
}) {
  return {
    key: criterion.key,
    label: criterion.label,
    description: criterion.description ?? null,
    weight: criterion.weight ?? 1,
    maxPoints: criterion.maxPoints ?? 5,
    required: criterion.required ?? true,
    sortOrder: criterion.sortOrder ?? 0,
  };
}

function toDocTypeCreateInput(docType: {
  key: string;
  label: string;
  required?: boolean;
  mimeAllow?: string[];
}) {
  return {
    key: docType.key,
    label: docType.label,
    required: docType.required ?? true,
    mimeAllow: docType.mimeAllow ?? ['application/pdf'],
  };
}
