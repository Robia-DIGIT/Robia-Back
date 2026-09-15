import { Module } from '@nestjs/common';
import { CompetitorsService } from './competitors.service';
import { CompetitorsController } from './competitors.controller';
import { AuditRunnerService } from '../audits/audit-runner/audit-runner.service';

@Module({
  providers: [CompetitorsService, AuditRunnerService],
  controllers: [CompetitorsController],
})
export class CompetitorsModule {}
