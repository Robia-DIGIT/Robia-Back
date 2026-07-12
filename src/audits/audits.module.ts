import { Module } from '@nestjs/common';
import { AuditsService } from './audits.service';
import { AuditsController } from './audits.controller';
import { AuditRunnerService } from './audit-runner/audit-runner.service';

@Module({
  providers: [AuditsService, AuditRunnerService],
  controllers: [AuditsController],
  exports: [AuditsService],
})
export class AuditsModule {}
