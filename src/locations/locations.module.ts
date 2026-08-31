import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { LocationPlacesService } from './location-places/location-places.service';

@Module({
  controllers: [LocationsController],
  providers: [LocationsService, LocationPlacesService],
})
export class LocationsModule {}