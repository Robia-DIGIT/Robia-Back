import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ValidationLogsService } from './validation-logs.service';
import { CreateValidationLogDto } from './dto/create-validation-log.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('validations')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class ValidationLogsController {
  constructor(
    private readonly validationLogsService: ValidationLogsService,
  ) {}

  @Post()
  create(@Req() req: ScopedRequest, @Body() dto: CreateValidationLogDto) {
    return this.validationLogsService.create(
      req.organizationId,
      req.user.userId,
      dto,
    );
  }

  @Get()
  findAll(@Req() req: ScopedRequest) {
    return this.validationLogsService.findAll(req.organizationId);
  }
}