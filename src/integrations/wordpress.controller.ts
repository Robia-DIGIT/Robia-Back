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
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';
import { ApproveWordPressDraftDto } from './dto/approve-wordpress-draft.dto';
import { ConnectWordPressDto } from './dto/connect-wordpress.dto';
import { CreateWordPressDraftDto } from './dto/create-wordpress-draft.dto';
import { WordPressService } from './wordpress.service';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('integrations/wordpress')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class WordPressController {
  constructor(private readonly wordpress: WordPressService) {}

  @Post('connect')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  connect(@Req() request: ScopedRequest, @Body() dto: ConnectWordPressDto) {
    return this.wordpress.connect(request.organizationId, dto);
  }

  @Get('status')
  status(@Req() request: ScopedRequest, @Query('websiteId') websiteId: string) {
    return this.wordpress.status(request.organizationId, websiteId);
  }

  @Delete()
  disconnect(
    @Req() request: ScopedRequest,
    @Query('websiteId') websiteId: string,
  ) {
    return this.wordpress.disconnect(request.organizationId, websiteId);
  }

  @Post('draft-approvals')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  approveDraft(
    @Req() request: ScopedRequest,
    @Body() dto: ApproveWordPressDraftDto,
  ) {
    return this.wordpress.approveDraft(
      request.organizationId,
      request.user.userId,
      dto,
    );
  }

  @Delete('draft-approvals/:approvalId')
  revokeApproval(
    @Req() request: ScopedRequest,
    @Param('approvalId') approvalId: string,
  ) {
    return this.wordpress.revokeApproval(request.organizationId, approvalId);
  }

  @Post('drafts')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createDraft(
    @Req() request: ScopedRequest,
    @Body() dto: CreateWordPressDraftDto,
  ) {
    return this.wordpress.createDraft(
      request.organizationId,
      request.user.userId,
      dto,
    );
  }

  @Post('drafts/:attemptId/reconcile')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  reconcile(
    @Req() request: ScopedRequest,
    @Param('attemptId') attemptId: string,
  ) {
    return this.wordpress.reconcileDraft(
      request.organizationId,
      request.user.userId,
      attemptId,
    );
  }

  @Get('attempts')
  attempts(
    @Req() request: ScopedRequest,
    @Query('websiteId') websiteId: string,
  ) {
    return this.wordpress.listAttempts(request.organizationId, websiteId);
  }
}
