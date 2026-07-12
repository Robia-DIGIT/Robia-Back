import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuditsService } from './audits.service';
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
  run(@Req() req: ScopedRequest) {
    return this.auditsService.run(req.organizationId);
  }

  @Get('latest')
  findLatest(@Req() req: ScopedRequest) {
    return this.auditsService.findLatest(req.organizationId);
  }

  @Get(':id')
  findOne(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.auditsService.findOne(req.organizationId, id);
  }
}