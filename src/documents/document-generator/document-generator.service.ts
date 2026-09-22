import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface GeneratedDocument {
  title: string;
  content: string;
}

export interface DocumentGenerationContext {
  organizationName: string;
  sector?: string | null;
  city?: string | null;
  country?: string | null;
  websiteUrl: string;
  objective: string;
  audience?: string;
  tone?: string;
  locale?: string;
  userProvidedFacts: string[];
}

@Injectable()
export class DocumentGeneratorService {
  private readonly aiEngineUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.aiEngineUrl =
      this.configService.get<string>('AI_ENGINE_URL') ??
      'http://localhost:8000';
  }

  async generate(
    type: string,
    opportunityTitle: string,
    opportunityDescription: string,
    context: DocumentGenerationContext,
  ): Promise<GeneratedDocument> {
    const response = await fetch(`${this.aiEngineUrl}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        opportunity_title: opportunityTitle,
        opportunity_description: opportunityDescription,
        context: {
          organization_name: context.organizationName,
          sector: context.sector,
          city: context.city,
          country: context.country,
          website_url: context.websiteUrl,
          objective: context.objective,
          audience: context.audience,
          tone: context.tone,
          locale: context.locale,
          user_provided_facts: context.userProvidedFacts,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `AI engine /documents failed with status ${response.status}`,
      );
    }

    return (await response.json()) as GeneratedDocument;
  }
}
