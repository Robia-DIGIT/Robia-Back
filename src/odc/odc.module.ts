import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { OdcController } from './odc.controller';
import { OdcProgramsService } from './odc-programs.service';
import { OdcApplicationsService } from './odc-applications.service';
import { OdcOutreachService } from './odc-outreach.service';

@Module({
  imports: [NotificationsModule],
  controllers: [OdcController],
  providers: [OdcProgramsService, OdcApplicationsService, OdcOutreachService],
  exports: [OdcProgramsService, OdcApplicationsService],
})
export class OdcModule {}
