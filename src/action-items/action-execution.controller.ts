import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';
import { ActionExecutionService } from './action-execution.service';
import { RejectActionDto } from './dto/reject-action.dto';
import { RecordActionExecutionDto } from './dto/record-action-execution.dto';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('actions')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class ActionExecutionController {
  constructor(private readonly execution: ActionExecutionService) {}

  @Post(':id/submit')
  submit(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.execution.submit(req.organizationId, req.user.userId, id);
  }

  @Post(':id/approve')
  approve(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.execution.approve(req.organizationId, req.user.userId, id);
  }

  @Post(':id/reject')
  reject(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: RejectActionDto,
  ) {
    return this.execution.reject(req.organizationId, req.user.userId, id, dto);
  }

  @Post(':id/execution-attempts')
  recordExecution(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: RecordActionExecutionDto,
  ) {
    return this.execution.recordExecution(
      req.organizationId,
      req.user.userId,
      id,
      dto,
    );
  }

  @Get(':id/history')
  history(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.execution.history(req.organizationId, id);
  }
}
