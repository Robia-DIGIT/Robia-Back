import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
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
  findAll(@Req() req: ScopedRequest) {
    return this.websitesService.findAll(req.organizationId);
  }

  @Get(':id')
  findOne(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.websitesService.findOne(req.organizationId, id);
  }
}
