import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { LocationsService } from './locations.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { SearchPlacesDto } from './dto/search-places.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgScopeGuard } from '../common/guards/org-scope.guard';

interface ScopedRequest extends Request {
  user: { userId: string; email: string };
  organizationId: string;
}

@Controller('locations')
@UseGuards(JwtAuthGuard, OrgScopeGuard)
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get('search-places')
  searchPlaces(@Query() query: SearchPlacesDto) {
    return this.locationsService.searchPlaces(query.query);
  }

  @Post()
  create(@Req() req: ScopedRequest, @Body() dto: CreateLocationDto) {
    return this.locationsService.create(req.organizationId, dto);
  }

  @Get()
  findAll(@Req() req: ScopedRequest) {
    return this.locationsService.findAll(req.organizationId);
  }

  @Get(':id')
  findOne(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.locationsService.findOne(req.organizationId, id);
  }

  @Get(':id/weather')
  getWeather(@Req() req: ScopedRequest, @Param('id') id: string) {
    return this.locationsService.getWeather(req.organizationId, id);
  }
}