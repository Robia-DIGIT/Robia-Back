import { Global, Module } from '@nestjs/common';
import { N8nWebhookService } from './n8n-webhook.service';
import { GoogleSearchConsoleController } from './google-search-console.controller';
import { GoogleSearchConsoleService } from './google-search-console.service';
import { MetaController } from './meta.controller';
import { MetaService } from './meta.service';
import { GoogleBusinessProfileController } from './google-business-profile.controller';
import { GoogleBusinessProfileService } from './google-business-profile.service';
import { WordPressController } from './wordpress.controller';
import { WordPressSafeHttpService } from './wordpress-safe-http.service';
import { WordPressService } from './wordpress.service';

@Global()
@Module({
  controllers: [
    GoogleSearchConsoleController,
    GoogleBusinessProfileController,
    MetaController,
    WordPressController,
  ],
  providers: [
    N8nWebhookService,
    GoogleSearchConsoleService,
    GoogleBusinessProfileService,
    MetaService,
    WordPressSafeHttpService,
    WordPressService,
  ],
  exports: [
    N8nWebhookService,
    GoogleSearchConsoleService,
    GoogleBusinessProfileService,
    MetaService,
    WordPressService,
  ],
})
export class IntegrationsModule {}
