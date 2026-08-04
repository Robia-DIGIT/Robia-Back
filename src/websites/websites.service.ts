import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWebsiteDto } from './dto/create-website.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class WebsitesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, dto: CreateWebsiteDto) {
    const domain = this.extractDomain(dto.url);

    try {
      return await this.prisma.website.create({
        data: {
          organizationId,
          url: dto.url,
          domain,
          status: 'pending',
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ce site est déjà enregistré pour votre organisation.',
        );
      }
      throw error;
    }
  }

  async findAll(organizationId: string, includeArchived = false) {
    return this.prisma.website.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { status: { not: 'archived' } }),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(organizationId: string, websiteId: string) {
    const website = await this.prisma.website.findFirst({
      where: { id: websiteId, organizationId },
    });

    if (!website) {
      throw new NotFoundException('Aucun site connecté pour cette organisation');
    }

    return website;
  }

  async updateStatus(
    organizationId: string,
    websiteId: string,
    status: 'pending' | 'valid' | 'unreachable',
  ) {
    await this.findOne(organizationId, websiteId); // vérifie l'appartenance

    return this.prisma.website.update({
      where: { id: websiteId },
      data: { status, lastCheckedAt: new Date() },
    });
  }

  async archive(organizationId: string, websiteId: string) {
    await this.findOne(organizationId, websiteId);

    return this.prisma.website.update({
      where: { id: websiteId },
      data: { status: 'archived' },
    });
  }

  async restore(organizationId: string, websiteId: string) {
    const website = await this.findOne(organizationId, websiteId);

    if (website.status !== 'archived') {
      throw new ConflictException("Ce site n'est pas archivé.");
    }

    return this.prisma.website.update({
      where: { id: websiteId },
      data: { status: 'pending' },
    });
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }
}