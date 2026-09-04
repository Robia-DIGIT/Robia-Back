import { Body, Controller, Get, Param, Post as HttpPost, Query, Req, UseGuards } from '@nestjs/common';
import { ContentService } from './content.service';
import { GenerateSocialPostsDto } from './dto/generate-social-posts.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('content')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @HttpPost('social-posts/generate')
  generate(@Req() req: ScopedRequest, @Body() dto: GenerateSocialPostsDto) {
    return this.contentService.generateForLocation(req.organizationId, dto.locationId);
  }

  @Get('posts')
  findAll(@Req() req: ScopedRequest, @Query('location_id') locationId: string) {
    return this.contentService.findAllForLocation(req.organizationId, locationId);
  }

  @Get('posts/:id')
  findOne(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.contentService.findOne(req.organizationId, id);
  }
}