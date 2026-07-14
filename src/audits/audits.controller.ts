import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuditsService } from './audits.service';
import { RunAuditDto } from './dto/run-audit.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('audits')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class AuditsController {
  constructor(private readonly auditsService: AuditsService) {}

  @Post('run')
  run(@Req() req: ScopedRequest, @Body() dto: RunAuditDto) {
    return this.auditsService.run(req.organizationId, dto.websiteId);
  }

  @Get('latest')
  findLatest(@Req() req: ScopedRequest, @Query('website_id') websiteId: string) {
    return this.auditsService.findLatestForWebsite(req.organizationId, websiteId);
  }


  @Get(':id')
  findOne(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.auditsService.findOne(req.organizationId, id);
  }
}
