import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ActionItemsService } from './action-items.service';
import { UpdateActionStatusDto } from './dto/update-action-status.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('actions')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class ActionItemsController {
  constructor(private readonly actionItemsService: ActionItemsService) {}

  @Post('generate')
  generate(
    @Req() req: ScopedRequest,
    @Query('opportunity_id') opportunityId: string,
  ) {
    return this.actionItemsService.generateFromOpportunity(
      req.organizationId,
      opportunityId,
    );
  }

  @Get()
  findAll(@Req() req: ScopedRequest) {
    return this.actionItemsService.findAll(req.organizationId);
  }

  @Patch(':id/status')
  updateStatus(
    @Req() req: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateActionStatusDto,
  ) {
    return this.actionItemsService.updateStatus(
      req.organizationId,
      id,
      dto,
    );
  }
}
