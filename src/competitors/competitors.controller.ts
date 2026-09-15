import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CompetitorsService } from './competitors.service';
import { CreateCompetitorDto } from './dto/create-competitor.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
  id?: string;
}

@Controller('competitors')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class CompetitorsController {
  constructor(private readonly competitorsService: CompetitorsService) {}

  @Post()
  create(@Req() req: ScopedRequest, @Body() dto: CreateCompetitorDto) {
    return this.competitorsService.create(req.organizationId, dto);
  }

  @Get()
  findAllForWebsite(
    @Req() req: ScopedRequest,
    @Query('website_id') websiteId: string,
  ) {
    return this.competitorsService.findAllForWebsite(
      req.organizationId,
      websiteId,
    );
  }

  @Post(':id/run')
  run(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.competitorsService.run(req.organizationId, id);
  }

  @Delete(':id')
  remove(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.competitorsService.remove(req.organizationId, id);
  }
}
