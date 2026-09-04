import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SocialPostVariant {
  label: string;
  content: string;
}

interface GenerateSocialPostsParams {
  businessName: string;
  sector?: string | null;
  city?: string | null;
  weatherDescription: string;
  temperatureC: number;
  openingHoursToday?: string | null;
  topKeywords: string[];
}

@Injectable()
export class ContentGeneratorService {
  private readonly aiEngineUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.aiEngineUrl =
      this.configService.get<string>('AI_ENGINE_URL') ?? 'http://localhost:8001';
  }

  async generateSocialPosts({
    businessName,
    sector,
    city,
    weatherDescription,
    temperatureC,
    openingHoursToday,
    topKeywords,
  }: GenerateSocialPostsParams): Promise<SocialPostVariant[]> {
    const response = await fetch(`${this.aiEngineUrl}/content/social-post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_name: businessName,
        sector,
        city,
        weather_description: weatherDescription,
        temperature_c: temperatureC,
        opening_hours_today: openingHoursToday,
        top_keywords: topKeywords,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `AI engine /content/social-post failed with status ${response.status}`,
      );
    }

    const data = await response.json();
    return data.variants;
  }
}