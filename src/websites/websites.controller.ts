import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { WebsitesService } from './websites.service';
import { CreateWebsiteDto } from './dto/create-website.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('websites')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class WebsitesController {
  constructor(private readonly websitesService: WebsitesService) {}

  @Post()
  create(@Req() req: ScopedRequest, @Body() dto: CreateWebsiteDto) {
    return this.websitesService.create(req.organizationId, dto);
  }

  @Get()
  findAll(
    @Req() req: ScopedRequest,
    @Query('include_archived') includeArchived?: string,
  ) {
    return this.websitesService.findAll(
      req.organizationId,
      includeArchived === 'true',
    );
  }

  @Get(':id')
  findOne(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.websitesService.findOne(req.organizationId, id);
  }

  @Delete(':id')
  archive(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.websitesService.archive(req.organizationId, id);
  }

  @Patch(':id/restore')
  restore(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.websitesService.restore(req.organizationId, id);
  }
}