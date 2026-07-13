import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
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
  generate(@Req() req: ScopedRequest) {
    return this.opportunitiesService.generateFromLatestAudit(
      req.organizationId,
    );
  }

  @Get()
  findAll(@Req() req: ScopedRequest) {
    return this.opportunitiesService.findAll(req.organizationId);
  }

  @Get(':id')
  findOne(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.opportunitiesService.findOne(req.organizationId, id);
  }
}
