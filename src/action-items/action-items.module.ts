import { Module } from '@nestjs/common';
import { ActionItemsService } from './action-items.service';
import { ActionItemsController } from './action-items.controller';
import { ActionGeneratorService } from './action-generator/action-generator.service';
import { PdfExportService } from './pdf-export/pdf-export.service';

@Module({
  providers: [ActionItemsService, ActionGeneratorService, PdfExportService],
  controllers: [ActionItemsController],
  exports: [ActionItemsService],
})
export class ActionItemsModule {}