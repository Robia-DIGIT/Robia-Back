import { Module } from '@nestjs/common';
import { ValidationLogsService } from './validation-logs.service';
import { ValidationLogsController } from './validation-logs.controller';

@Module({
  providers: [ValidationLogsService],
  controllers: [ValidationLogsController],
  exports: [ValidationLogsService]
})
export class ValidationLogsModule {}
