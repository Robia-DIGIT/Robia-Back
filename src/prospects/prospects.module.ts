import { Module } from '@nestjs/common';
import { ProspectsController } from './prospects.controller';
import { ProspectsService } from './prospects.service';

@Module({
  controllers: [ProspectsController],
  providers: [ProspectsService],
})
export class ProspectsModule {}
