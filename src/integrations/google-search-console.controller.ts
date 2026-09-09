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
import type { Response } from 'express';
import type { Request as ExpressRequest } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';
import { SelectSearchConsoleSiteDto } from './dto/select-search-console-site.dto';
import { SelectGoogleAnalyticsPropertyDto } from './dto/select-google-analytics-property.dto';
import { GoogleSearchConsoleService } from './google-search-console.service';

interface ScopedRequest extends ExpressRequest {
  user: { userId: string; email: string };
  organizationId: string;
}

const OAUTH_STATE_COOKIE = 'robia_google_oauth_state';
const OAUTH_CALLBACK_PATH = '/integrations/google/search-console/callback';

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

@Controller('integrations/google/search-console')
export class GoogleSearchConsoleController {
  constructor(private readonly searchConsole: GoogleSearchConsoleService) {}

  @Get('authorize')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  authorize(
    @Req() request: ScopedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const url = this.searchConsole.getAuthorizationUrl(
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
      return response.redirect(
        this.searchConsole.getDashboardRedirect('error'),
      );
    }
    if (oauthError) {
      return response.redirect(
        this.searchConsole.getDashboardRedirect('denied'),
      );
    }
    try {
      await this.searchConsole.completeAuthorization(code ?? '', state ?? '');
      return response.redirect(
        this.searchConsole.getDashboardRedirect('connected'),
      );
    } catch {
      return response.redirect(
        this.searchConsole.getDashboardRedirect('error'),
      );
    }
  }

  @Get('status')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  status(@Req() request: ScopedRequest) {
    return this.searchConsole.getStatus(request.organizationId);
  }

  @Get('sites')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  sites(@Req() request: ScopedRequest) {
    return this.searchConsole.listSites(request.organizationId);
  }

  @Post('site')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  selectSite(
    @Req() request: ScopedRequest,
    @Body() dto: SelectSearchConsoleSiteDto,
  ) {
    return this.searchConsole.selectSite(request.organizationId, dto.siteUrl);
  }

  @Get('performance')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  performance(@Req() request: ScopedRequest) {
    return this.searchConsole.getPerformance(request.organizationId);
  }

  @Get('analytics/properties')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  analyticsProperties(@Req() request: ScopedRequest) {
    return this.searchConsole.listAnalyticsProperties(request.organizationId);
  }

  @Post('analytics/property')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  selectAnalyticsProperty(
    @Req() request: ScopedRequest,
    @Body() dto: SelectGoogleAnalyticsPropertyDto,
  ) {
    return this.searchConsole.selectAnalyticsProperty(
      request.organizationId,
      dto.propertyId,
    );
  }

  @Get('analytics/performance')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  analyticsPerformance(@Req() request: ScopedRequest) {
    return this.searchConsole.getAnalyticsPerformance(request.organizationId);
  }

  @Delete()
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  disconnect(@Req() request: ScopedRequest) {
    return this.searchConsole.disconnect(request.organizationId);
  }
}
