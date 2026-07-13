import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { DocumentsController } from './documents.controller';
import { DocumentGeneratorService } from './document-generator/document-generator.service';

@Module({
  providers: [DocumentsService, DocumentGeneratorService],
  controllers: [DocumentsController],
  exports: [DocumentsService],
})
export class DocumentsModule {}
