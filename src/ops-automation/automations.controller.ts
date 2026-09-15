import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AutomationsService } from './automations.service';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { SetAutomationEnabledDto } from './dto/set-automation-enabled.dto';
import { ReviewAutomationRunDto } from './dto/review-automation-run.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('ops/automations')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class AutomationsController {
  constructor(private readonly automationsService: AutomationsService) {}

  @Post()
  create(@Req() req: ScopedRequest, @Body() dto: CreateAutomationDto) {
    return this.automationsService.create(
      req.organizationId,
      req.user.userId,
      dto,
    );
  }

  @Get()
  findAll(@Req() req: ScopedRequest) {
    return this.automationsService.findAll(req.organizationId);
  }

  @Get(':id')
  findOne(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.automationsService.findOne(req.organizationId, id);
  }

  @Patch(':id')
  update(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateAutomationDto,
  ) {
    return this.automationsService.update(req.organizationId, id, dto);
  }

  @Patch(':id/enabled')
  setEnabled(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: SetAutomationEnabledDto,
  ) {
    return this.automationsService.setEnabled(
      req.organizationId,
      id,
      dto.enabled,
    );
  }

  @Post(':id/run')
  triggerManual(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.automationsService.triggerManual(
      req.organizationId,
      req.user.userId,
      id,
    );
  }

  @Get(':id/runs')
  listRuns(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.automationsService.listRuns(req.organizationId, id);
  }

  @Get('runs/:runId')
  getRun(@Req() req: ScopedRequest, @Param('runId') runId: string) {
    return this.automationsService.getRun(req.organizationId, runId);
  }

  @Post('runs/:runId/approve')
  approveRun(
    @Req() req: ScopedRequest,
    @Param('runId') runId: string,
    @Body() dto: ReviewAutomationRunDto,
  ) {
    return this.automationsService.approveRun(
      req.organizationId,
      req.user.userId,
      runId,
      dto.reason,
    );
  }

  @Post('runs/:runId/reject')
  rejectRun(
    @Req() req: ScopedRequest,
    @Param('runId') runId: string,
    @Body() dto: ReviewAutomationRunDto,
  ) {
    return this.automationsService.rejectRun(
      req.organizationId,
      req.user.userId,
      runId,
      dto.reason,
    );
  }
}
