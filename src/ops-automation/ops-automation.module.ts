import { Module } from '@nestjs/common';
import { AuditsModule } from '../audits/audits.module';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';
import { AutomationContextService } from './automation-context.service';
import { OpsActionsRegistryService } from './actions/ops-actions-registry.service';
import { AuditCompletedEventListener } from './audit-completed-event.listener';
import { AutomationSchedulerService } from './automation-scheduler.service';
import { AutomationStepRetryDispatcherService } from './automation-step-retry-dispatcher.service';

@Module({
  imports: [AuditsModule, OpportunitiesModule, NotificationsModule],
  controllers: [AutomationsController],
  providers: [
    AutomationsService,
    AutomationContextService,
    OpsActionsRegistryService,
    AuditCompletedEventListener,
    AutomationSchedulerService,
    AutomationStepRetryDispatcherService,
  ],
  exports: [AutomationsService, OpsActionsRegistryService],
})
export class OpsAutomationModule {}
