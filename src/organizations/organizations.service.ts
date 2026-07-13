import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateOrganizationDto) {
    const existing = await this.prisma.organization.findFirst({
      where: { ownerId: userId },
    });

    if (existing) {
      throw new ConflictException(
        'Cet utilisateur possède déjà une organisation',
      );
    }

    return this.prisma.organization.create({
      data: {
        ...dto,
        ownerId: userId,
      },
    });
  }

  async findCurrent(userId: string) {
    const org = await this.prisma.organization.findFirst({
      where: { ownerId: userId },
    });

    if (!org) {
      throw new NotFoundException('Aucune organisation trouvée');
    }

    return org;
  }

  async updateCurrent(userId: string, dto: UpdateOrganizationDto) {
    const org = await this.findCurrent(userId);

    return this.prisma.organization.update({
      where: { id: org.id },
      data: dto,
    });
  }
}
