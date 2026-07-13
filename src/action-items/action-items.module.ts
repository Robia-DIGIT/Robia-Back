import { Module } from '@nestjs/common';
import { ActionItemsService } from './action-items.service';
import { ActionItemsController } from './action-items.controller';
import { ActionGeneratorService } from './action-generator/action-generator.service';

@Module({
  providers: [ActionItemsService, ActionGeneratorService],
  controllers: [ActionItemsController],
  exports: [ActionItemsService],
})
export class ActionItemsModule {}