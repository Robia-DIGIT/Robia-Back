import { Module } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunityGeneratorService } from './opportunity-generator/opportunity-generator.service';

@Module({
  providers: [OpportunitiesService, OpportunityGeneratorService],
  controllers: [OpportunitiesController],
  exports: [OpportunitiesService],
})
export class OpportunitiesModule {}