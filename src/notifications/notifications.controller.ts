import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';
import { toNotificationDeliverySummary } from './dto/notification-delivery.dto';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

// RC-26 — operational follow-up only. Never exposes SMTP_PASSWORD, any
// other transport internals, or a recipient's full email address (see
// toNotificationDeliverySummary()). No frontend in this PR — see
// docs/RC26_NOTIFICATION_DELIVERY.md's "Plan frontend minimal".
@Controller('ops/notifications')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async findAll(@Req() req: ScopedRequest) {
    const deliveries = await this.notifications.findAllForOrganization(
      req.organizationId,
    );
    return deliveries.map(toNotificationDeliverySummary);
  }

  @Get(':id')
  async findOne(@Req() req: ScopedRequest, @Param('id') id: string) {
    const delivery = await this.notifications.findOne(req.organizationId, id);
    return toNotificationDeliverySummary(delivery);
  }

  @Post(':id/retry')
  async retry(@Req() req: ScopedRequest, @Param('id') id: string) {
    await this.notifications.retry(req.organizationId, id);
    const delivery = await this.notifications.findOne(req.organizationId, id);
    return toNotificationDeliverySummary(delivery);
  }
}
