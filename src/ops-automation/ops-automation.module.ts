import { Module } from '@nestjs/common';
import { AuditsModule } from '../audits/audits.module';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OdcModule } from '../odc/odc.module';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';
import { AutomationContextService } from './automation-context.service';
import { OpsActionsRegistryService } from './actions/ops-actions-registry.service';
import { AuditCompletedEventListener } from './audit-completed-event.listener';
import { OdcEventListener } from './odc-event.listener';
import { AutomationSchedulerService } from './automation-scheduler.service';
import { AutomationStepRetryDispatcherService } from './automation-step-retry-dispatcher.service';

// RC-29 — imports OdcModule (for OpsActionsRegistryService's 3 new
// robia.odc.* actions) one-directionally: OdcModule never imports this
// module back, so there is no circular dependency — see odc-events.ts's own
// doc comment for why the OTHER direction (ODC's own events reaching
// AutomationsService) goes through OdcEventListener + @nestjs/event-emitter
// instead of a direct import.
@Module({
  imports: [AuditsModule, OpportunitiesModule, NotificationsModule, OdcModule],
  controllers: [AutomationsController],
  providers: [
    AutomationsService,
    AutomationContextService,
    OpsActionsRegistryService,
    AuditCompletedEventListener,
    OdcEventListener,
    AutomationSchedulerService,
    AutomationStepRetryDispatcherService,
  ],
  exports: [AutomationsService, OpsActionsRegistryService],
})
export class OpsAutomationModule {}
