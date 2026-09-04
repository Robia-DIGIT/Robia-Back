import { Module } from '@nestjs/common';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { ContentGeneratorService } from './content-generator/content-generator.service';
import { LocationsModule } from '../locations/locations.module';

@Module({
  imports: [LocationsModule],
  controllers: [ContentController],
  providers: [ContentService, ContentGeneratorService],
})
export class ContentModule {}