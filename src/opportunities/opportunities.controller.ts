import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import {GenerateOpportunitiesDto} from './dto/generate-opportunities.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('opportunities')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class OpportunitiesController {
  constructor(private readonly opportunitiesService: OpportunitiesService) {}

  @Post('generate')
  generate(@Req() req: ScopedRequest, @Body() dto: GenerateOpportunitiesDto) {
    return this.opportunitiesService.generateFromAudit(
      req.organizationId, dto.auditId
    );
  }

  @Post('generate-site')
  generateSite(@Req() req: ScopedRequest, @Body() dto: GenerateOpportunitiesDto) {
    return this.opportunitiesService.generateFromSiteAudit(
      req.organizationId, dto.auditId
    );
  }

  @Get()
  findAll(@Req() req: ScopedRequest, @Query('audit_id') auditId: string) {
    return this.opportunitiesService.findAllForAudit(req.organizationId, auditId);
  }

  @Get(':id')
  findOne(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.opportunitiesService.findOne(req.organizationId, id);
  }
}
