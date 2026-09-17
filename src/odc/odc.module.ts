import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { OdcController } from './odc.controller';
import { OdcProgramsService } from './odc-programs.service';
import { OdcApplicationsService } from './odc-applications.service';
import { OdcOutreachService } from './odc-outreach.service';
import { OdcDocumentsService } from './odc-documents.service';
import { ODC_STORAGE } from './storage/odc-storage';
import { LocalOdcStorage } from './storage/local-odc-storage';

@Module({
  imports: [NotificationsModule],
  controllers: [OdcController],
  providers: [
    OdcProgramsService,
    OdcApplicationsService,
    OdcOutreachService,
    OdcDocumentsService,
    { provide: ODC_STORAGE, useClass: LocalOdcStorage },
  ],
  exports: [OdcProgramsService, OdcApplicationsService],
})
export class OdcModule {}
