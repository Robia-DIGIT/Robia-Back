import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { LocationPlacesService } from './location-places/location-places.service';
import { LocationWeatherService } from './location-weather/location-weather.service';

@Module({
  controllers: [LocationsController],
  providers: [LocationsService, LocationPlacesService, LocationWeatherService],
})
export class LocationsModule {}