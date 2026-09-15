import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IntelligenceRegistryService } from './intelligence-registry.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

/**
 * RC-21 — org-scoped, read-only intelligence endpoints. Both routes only
 * ever read: neither can create, update, or delete anything, and neither
 * can influence `seo_score_v2`/`globalScore`.
 */
@Controller('intelligence')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class IntelligenceController {
  constructor(
    private readonly registry: IntelligenceRegistryService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('status')
  getStatus(@Req() req: ScopedRequest) {
    return this.registry.getStatus(req.organizationId);
  }

  @Get('findings')
  async getFindings(
    @Req() req: ScopedRequest,
    @Query('auditId') auditId?: string,
  ) {
    if (!auditId) {
      throw new BadRequestException('Le paramètre auditId est requis.');
    }

    // Org-scoped by construction, same pattern as OpportunitiesService.findOne:
    // a mismatched organizationId yields 404, never leaking whether the
    // audit exists for a different organization.
    const audit = await this.prisma.audit.findFirst({
      where: { id: auditId, organizationId: req.organizationId },
      select: { id: true, resultJson: true },
    });
    if (!audit) {
      throw new NotFoundException('Audit non trouvé.');
    }

    return this.registry.collectFindings(req.organizationId, {
      auditId: audit.id,
      auditResult: audit.resultJson as Record<string, unknown> | null,
    });
  }
}
