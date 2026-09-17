import { Module } from '@nestjs/common';
import { OdcController } from './odc.controller';
import { OdcProgramsService } from './odc-programs.service';
import { OdcApplicationsService } from './odc-applications.service';

// RC-29 — deliberately never imports OpsAutomationModule: it only emits
// plain @nestjs/event-emitter events (see odc-events.ts) that
// OpsAutomationModule's own OdcEventListener turns into real
// AutomationEvent rows. OpsAutomationModule imports THIS module (for
// OdcApplicationsService, used by its 3 new registry actions) — a
// one-directional dependency that avoids the circular import a direct call
// the other way would create. See odc-events.ts's own doc comment.
@Module({
  controllers: [OdcController],
  providers: [OdcProgramsService, OdcApplicationsService],
  exports: [OdcProgramsService, OdcApplicationsService],
})
export class OdcModule {}
