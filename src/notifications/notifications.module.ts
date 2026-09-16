import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { SmtpNotificationTransport } from './smtp-notification-transport.service';
import { NOTIFICATION_TRANSPORT } from './notification-transport';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationDispatcherService,
    {
      provide: NOTIFICATION_TRANSPORT,
      useClass: SmtpNotificationTransport,
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
