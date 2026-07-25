import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface GeneratedDocument {
  title: string;
  content: string;
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
  ): Promise<GeneratedDocument> {
    const response = await fetch(`${this.aiEngineUrl}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        opportunity_title: opportunityTitle,
        opportunity_description: opportunityDescription,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `AI engine /documents failed with status ${response.status}`,
      );
    }

    return response.json()
  }
}
