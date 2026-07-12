import { Module } from '@nestjs/common';
import { WebsitesService } from './websites.service';
import { WebsitesController } from './websites.controller';

@Module({
  providers: [WebsitesService],
  controllers: [WebsitesController]
})
export class WebsitesModule {}
