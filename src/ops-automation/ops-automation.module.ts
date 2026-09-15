import { Module } from '@nestjs/common';
import { AuditsModule } from '../audits/audits.module';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';
import { AutomationContextService } from './automation-context.service';
import { OpsActionsRegistryService } from './actions/ops-actions-registry.service';

@Module({
  imports: [AuditsModule, OpportunitiesModule],
  controllers: [AutomationsController],
  providers: [
    AutomationsService,
    AutomationContextService,
    OpsActionsRegistryService,
  ],
  exports: [AutomationsService, OpsActionsRegistryService],
})
export class OpsAutomationModule {}
