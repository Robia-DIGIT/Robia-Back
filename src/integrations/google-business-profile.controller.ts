import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request as ExpressRequest, Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';
import { LinkGoogleBusinessLocationDto } from './dto/link-google-business-location.dto';
import { GoogleBusinessProfileService } from './google-business-profile.service';

interface ScopedRequest extends ExpressRequest {
  user: { userId: string; email: string };
  organizationId: string;
}

const OAUTH_STATE_COOKIE = 'robia_gbp_oauth_state';
const OAUTH_CALLBACK_PATH = '/integrations/google/business-profile/callback';

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

@Controller('integrations/google/business-profile')
export class GoogleBusinessProfileController {
  constructor(private readonly businessProfile: GoogleBusinessProfileService) {}

  @Get('authorize')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  authorize(
    @Req() request: ScopedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const url = this.businessProfile.getAuthorizationUrl(
      request.organizationId,
      request.user.userId,
    );
    response.cookie(
      OAUTH_STATE_COOKIE,
      new URL(url).searchParams.get('state'),
      {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 10 * 60 * 1000,
        path: OAUTH_CALLBACK_PATH,
      },
    );
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
        this.businessProfile.getDashboardRedirect('error'),
      );
    }
    if (oauthError) {
      return response.redirect(
        this.businessProfile.getDashboardRedirect('denied'),
      );
    }
    try {
      await this.businessProfile.completeAuthorization(code ?? '', state);
      return response.redirect(
        this.businessProfile.getDashboardRedirect('connected'),
      );
    } catch {
      return response.redirect(
        this.businessProfile.getDashboardRedirect('error'),
      );
    }
  }

  @Get('status')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  status(@Req() request: ScopedRequest) {
    return this.businessProfile.getStatus(request.organizationId);
  }

  @Get('locations')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  locations(@Req() request: ScopedRequest) {
    return this.businessProfile.listLocations(request.organizationId);
  }

  @Post('sync')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  sync(@Req() request: ScopedRequest) {
    return this.businessProfile.syncLocations(request.organizationId);
  }

  @Post('locations/:id/link')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  link(
    @Req() request: ScopedRequest,
    @Param('id') id: string,
    @Body() dto: LinkGoogleBusinessLocationDto,
  ) {
    return this.businessProfile.linkLocation(
      request.organizationId,
      id,
      dto.robiaLocationId,
    );
  }

  @Delete('locations/:id/link')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  unlink(@Req() request: ScopedRequest, @Param('id') id: string) {
    return this.businessProfile.unlinkLocation(request.organizationId, id);
  }

  @Get('locations/:id/reviews')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  reviews(@Req() request: ScopedRequest, @Param('id') id: string) {
    return this.businessProfile.listReviews(request.organizationId, id);
  }

  @Post('locations/:id/reviews/sync')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  syncReviews(@Req() request: ScopedRequest, @Param('id') id: string) {
    return this.businessProfile.syncReviews(request.organizationId, id);
  }

  @Get('locations/:id/performance')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  performance(@Req() request: ScopedRequest, @Param('id') id: string) {
    return this.businessProfile.getPerformanceMetrics(
      request.organizationId,
      id,
    );
  }

  @Delete()
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  disconnect(@Req() request: ScopedRequest) {
    return this.businessProfile.disconnect(request.organizationId);
  }
}
