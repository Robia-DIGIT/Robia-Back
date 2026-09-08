import { Global, Module } from '@nestjs/common';
import { N8nWebhookService } from './n8n-webhook.service';
import { GoogleSearchConsoleController } from './google-search-console.controller';
import { GoogleSearchConsoleService } from './google-search-console.service';

@Global()
@Module({
  controllers: [GoogleSearchConsoleController],
  providers: [N8nWebhookService, GoogleSearchConsoleService],
  exports: [N8nWebhookService, GoogleSearchConsoleService],
})
export class IntegrationsModule {}
