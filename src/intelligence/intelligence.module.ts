import { Global, Module } from '@nestjs/common';
import { IntelligenceController } from './intelligence.controller';
import { IntelligenceRegistryService } from './intelligence-registry.service';
import { SeoIntelligenceAdapter } from './adapters/seo-intelligence.adapter';
import { PageSpeedIntelligenceAdapter } from './adapters/pagespeed-intelligence.adapter';
import { SearchConsoleIntelligenceAdapter } from './adapters/search-console-intelligence.adapter';
import { Ga4IntelligenceAdapter } from './adapters/ga4-intelligence.adapter';
import { MetaIntelligenceAdapter } from './adapters/meta-intelligence.adapter';
import { GbpIntelligenceAdapter } from './adapters/gbp-intelligence.adapter';

/**
 * RC-21 — Unified Intelligence Core. `@Global()` so `OpportunitiesModule`
 * (and any future consumer) can inject `IntelligenceRegistryService`
 * without an explicit import, the same pattern `IntegrationsModule` and
 * `PrismaModule` already use for `MetaService`/`GoogleSearchConsoleService`
 * and `PrismaService`.
 */
@Global()
@Module({
  controllers: [IntelligenceController],
  providers: [
    IntelligenceRegistryService,
    SeoIntelligenceAdapter,
    PageSpeedIntelligenceAdapter,
    SearchConsoleIntelligenceAdapter,
    Ga4IntelligenceAdapter,
    MetaIntelligenceAdapter,
    GbpIntelligenceAdapter,
  ],
  exports: [IntelligenceRegistryService],
})
export class IntelligenceModule {}
