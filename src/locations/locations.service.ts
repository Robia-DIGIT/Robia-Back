import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LocationPlacesService } from './location-places/location-places.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { LocationWeatherService } from './location-weather/location-weather.service';

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly places: LocationPlacesService,
    private readonly weather: LocationWeatherService,
  ) {}

  async searchPlaces(query: string) {
    return this.places.searchPlaces(query);
  }

  /**
   * Crée un Location. Si placeId est fourni, pré-remplit adresse/coordonnées/
   * horaires via Google Places — les champs explicitement fournis dans le DTO
   * priment toujours sur ceux de Google (l'utilisateur peut corriger).
   */
  async create(organizationId: string, dto: CreateLocationDto) {
    let address = dto.address ?? null;
    let latitude: number | null = null;
    let longitude: number | null = null;
    let openingHours: Prisma.InputJsonObject | null = null;

    if (dto.placeId) {
      const details = await this.places.getPlaceDetails(dto.placeId);
      address = dto.address ?? details.formattedAddress;
      latitude = details.latitude;
      longitude = details.longitude;
      if (details.openingHoursText) {
        openingHours = { weekdayText: details.openingHoursText };
      }
    }

    return this.prisma.location.create({
      data: {
        organizationId,
        name: dto.name,
        address,
        city: dto.city,
        country: dto.country,
        latitude,
        longitude,
        openingHours: openingHours ?? undefined,
        isPrimary: dto.isPrimary ?? true,
      },
    });
  }

  async findAll(organizationId: string) {
    return this.prisma.location.findMany({ where: { organizationId } });
  }

  async findOne(organizationId: string, id: string) {
    const location = await this.prisma.location.findFirst({
      where: { id, organizationId },
    });

    if (!location) {
      throw new NotFoundException('Lieu non trouvé');
    }

    return location;
  }

  async getWeather(organizationId: string, id: string) {
    const location = await this.findOne(organizationId, id);

    if (location.latitude === null || location.longitude === null) {
      throw new Error(
        `Le lieu "${location.name}" n'a pas de coordonnées enregistrées — impossible de récupérer la météo.`,
      );
    }

    return this.weather.getCurrentWeather(location.latitude, location.longitude);
  }  
}