import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWebsiteDto } from './dto/create-website.dto';

@Injectable()
export class WebsitesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, dto: CreateWebsiteDto) {
    const domain = this.extractDomain(dto.url);

    return this.prisma.website.create({
      data: {
        organizationId,
        url: dto.url,
        domain,
        status: 'pending',
      },
    });
  }

  async findCurrent(organizationId: string) {
    const website = await this.prisma.website.findFirst({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
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
    // on vérifie que le site appartient bien à l'organisation avant modification
    const website = await this.prisma.website.findFirst({
      where: { id: websiteId, organizationId },
    });

    if (!website) {
      throw new NotFoundException('Site non trouvé pour cette organisation');
    }

    return this.prisma.website.update({
      where: { id: websiteId },
      data: { status, lastCheckedAt: new Date() },
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