import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request as ExpressRequest, Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';
import { SelectMetaPageDto } from './dto/select-meta-page.dto';
import { MetaService } from './meta.service';

interface ScopedRequest extends ExpressRequest {
  user: { userId: string; email: string };
  organizationId: string;
}

const OAUTH_STATE_COOKIE = 'robia_meta_oauth_state';
const OAUTH_CALLBACK_PATH = '/integrations/meta/callback';

function readCookie(request: ExpressRequest, name: string) {
  const prefix = `${name}=`;
  const segment = request.headers.cookie
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment.slice(prefix.length));
  } catch {
    return undefined;
  }
}

@Controller('integrations/meta')
export class MetaController {
  constructor(private readonly meta: MetaService) {}

  @Get('authorize')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  authorize(
    @Req() request: ScopedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const url = this.meta.getAuthorizationUrl(
      request.organizationId,
      request.user.userId,
    );
    const state = new URL(url).searchParams.get('state');
    response.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
      path: OAUTH_CALLBACK_PATH,
    });
    return { url };
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') oauthError: string | undefined,
    @Req() request: ExpressRequest,
    @Res() response: Response,
  ) {
    const browserState = readCookie(request, OAUTH_STATE_COOKIE);
    response.clearCookie(OAUTH_STATE_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: OAUTH_CALLBACK_PATH,
    });

    if (!state || !browserState || state !== browserState) {
      return response.redirect(this.meta.getDashboardRedirect('error'));
    }
    if (oauthError) {
      return response.redirect(this.meta.getDashboardRedirect('denied'));
    }

    try {
      await this.meta.completeAuthorization(code ?? '', state);
      return response.redirect(this.meta.getDashboardRedirect('connected'));
    } catch {
      return response.redirect(this.meta.getDashboardRedirect('error'));
    }
  }

  @Get('status')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  status(@Req() request: ScopedRequest) {
    return this.meta.getStatus(request.organizationId);
  }

  @Get('assets')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  assets(@Req() request: ScopedRequest) {
    return this.meta.listAssets(request.organizationId);
  }

  @Post('assets/select')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  selectAsset(
    @Req() request: ScopedRequest,
    @Body() dto: SelectMetaPageDto,
  ) {
    return this.meta.selectPage(request.organizationId, dto.pageId);
  }

  @Get('performance')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  performance(@Req() request: ScopedRequest) {
    return this.meta.getPerformance(request.organizationId);
  }

  @Delete()
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  disconnect(@Req() request: ScopedRequest) {
    return this.meta.disconnect(request.organizationId);
  }
}
