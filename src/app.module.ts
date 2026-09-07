import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { WebsitesModule } from './websites/websites.module';
import { AuditsModule } from './audits/audits.module';
import { OpportunitiesModule } from './opportunities/opportunities.module';
import { DocumentsModule } from './documents/documents.module';
import { ValidationLogsModule } from './validation-logs/validation-logs.module';
import { ActionItemsModule } from './action-items/action-items.module';
import { UsersModule } from './users/users.module';
import { LocationsModule } from './locations/locations.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { ProspectsModule } from './prospects/prospects.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    IntegrationsModule,
    AuthModule,
    OrganizationsModule,
    WebsitesModule,
    AuditsModule,
    OpportunitiesModule,
    DocumentsModule,
    ValidationLogsModule,
    ActionItemsModule,
    UsersModule,
    LocationsModule,
    ProspectsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
