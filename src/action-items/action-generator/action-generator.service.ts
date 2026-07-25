import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface GeneratedAction {
  title: string;
}

@Injectable()
export class ActionGeneratorService {
  private readonly aiEngineUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.aiEngineUrl =
      this.configService.get<string>('AI_ENGINE_URL') ??
      'http://localhost:8000';
  }

  async generateFromOpportunity(
    opportunityTitle: string,
    opportunityDescription: string,
  ): Promise<GeneratedAction[]> {
    const response = await fetch(`${this.aiEngineUrl}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        opportunity_title: opportunityTitle,
        opportunity_description: opportunityDescription,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `AI engine /actions failed with status ${response.status}`,
      );
    }

    return response.json();
  }
}
