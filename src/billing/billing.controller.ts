import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';
import { BillingService } from './billing.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('subscription')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  subscription(@Req() request: ScopedRequest) {
    return this.billing.getSubscription(request.organizationId);
  }

  @Post('checkout-session')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  checkout(
    @Req() request: ScopedRequest,
    @Body() dto: CreateCheckoutSessionDto,
  ) {
    return this.billing.createCheckoutSession(
      request.organizationId,
      request.user.email,
      dto.billingPeriod,
    );
  }

  @Post('portal-session')
  @UseGuards(JwtAuthGuard, OrgScopeGuard)
  portal(@Req() request: ScopedRequest) {
    return this.billing.createPortalSession(request.organizationId);
  }

  @Post('webhook')
  webhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.billing.handleWebhook(request.rawBody, signature);
  }
}
