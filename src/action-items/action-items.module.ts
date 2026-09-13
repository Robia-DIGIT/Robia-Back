import { Module } from '@nestjs/common';
import { ActionItemsService } from './action-items.service';
import { ActionItemsController } from './action-items.controller';
import { ActionGeneratorService } from './action-generator/action-generator.service';
import { PdfExportService } from './pdf-export/pdf-export.service';
import { ActionExecutionService } from './action-execution.service';
import { ActionExecutionController } from './action-execution.controller';

@Module({
  providers: [
    ActionItemsService,
    ActionGeneratorService,
    PdfExportService,
    ActionExecutionService,
  ],
  controllers: [ActionItemsController, ActionExecutionController],
  exports: [ActionItemsService],
})
export class ActionItemsModule {}
