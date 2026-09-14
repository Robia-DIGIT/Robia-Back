import { Global, Module } from '@nestjs/common';
import { N8nWebhookService } from './n8n-webhook.service';
import { GoogleSearchConsoleController } from './google-search-console.controller';
import { GoogleSearchConsoleService } from './google-search-console.service';
import { MetaController } from './meta.controller';
import { MetaService } from './meta.service';

@Global()
@Module({
  controllers: [GoogleSearchConsoleController, MetaController],
  providers: [N8nWebhookService, GoogleSearchConsoleService, MetaService],
  exports: [N8nWebhookService, GoogleSearchConsoleService, MetaService],
})
export class IntegrationsModule {}
