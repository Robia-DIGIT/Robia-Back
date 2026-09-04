import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LocationsService } from '../locations/locations.service';
import { ContentGeneratorService } from './content-generator/content-generator.service';

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locationsService: LocationsService,
    private readonly generator: ContentGeneratorService,
  ) {}

  /**
   * Extrait la ligne d'horaires du jour depuis le format Google Places
   * (weekdayText: ["Monday: Open 24 hours", ...]) stocké sur Location.
   * Retourne null si aucune donnée d'horaires n'est disponible.
   */
  private extractTodayOpeningHours(openingHours: unknown): string | null {
    if (!openingHours || typeof openingHours !== 'object') return null;
    const weekdayText = (openingHours as any).weekdayText;
    if (!Array.isArray(weekdayText)) return null;

    const todayName = WEEKDAY_NAMES[new Date().getDay()];
    const line = weekdayText.find((l: string) => l.startsWith(todayName));
    return line ?? null;
  }

  async generateForLocation(organizationId: string, locationId: string) {
    const location = await this.locationsService.findOne(organizationId, locationId);

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, sector: true, city: true },
    });

    if (!organization) {
      throw new NotFoundException('Organisation non trouvée');
    }

    if (location.latitude === null || location.longitude === null) {
      throw new Error(
        `Le lieu "${location.name}" n'a pas de coordonnées — impossible de récupérer la météo.`,
      );
    }

    const weather = await this.locationsService.getWeather(organizationId, locationId);

    // Mots-clés dominants issus du dernier audit de site complété pour
    // cette organisation — donnée déjà extraite par le moteur d'audit,
    // pas de nouvel appel nécessaire.
    // LIMITE CONNUE : on prend le dernier audit complété de l'organisation,
    // pas spécifiquement lié à ce Location. Fonctionne tant qu'une organisation
    // n'a qu'un seul site/lieu actif. À revoir (lier Location → Website
    // explicitement) quand le multi-lieux entrera en usage réel.
    const latestAudit = await this.prisma.audit.findFirst({
      where: { organizationId, status: 'completed' },
      orderBy: { createdAt: 'desc' },
    });
    const topKeywords: string[] =
      (latestAudit?.resultJson as any)?.top_keywords ?? [];

    const openingHoursToday = this.extractTodayOpeningHours(location.openingHours);

    const variants = await this.generator.generateSocialPosts({
      businessName: organization.name,
      sector: organization.sector,
      city: location.city ?? organization.city,
      weatherDescription: weather.description,
      temperatureC: weather.temperatureC,
      openingHoursToday,
      topKeywords,
    });

    const sourceData = {
      weather: {
        description: weather.description,
        temperatureC: weather.temperatureC,
      },
      openingHoursToday,
      topKeywords,
      generatedAt: new Date().toISOString(),
    };

    return this.prisma.$transaction(
      variants.map((variant) =>
        this.prisma.post.create({
          data: {
            organizationId,
            locationId,
            angle: variant.label,
            content: variant.content,
            status: 'draft',
            sourceData,
          },
        }),
      ),
    );
  }

  async findAllForLocation(organizationId: string, locationId: string) {
    return this.prisma.post.findMany({
      where: { organizationId, locationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(organizationId: string, id: string) {
    const post = await this.prisma.post.findFirst({
      where: { id, organizationId },
    });

    if (!post) {
      throw new NotFoundException('Post non trouvé');
    }

    return post;
  }
}