import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface GeneratedOpportunity {
  title: string;
  description: string;
  category: string;
  impact_score: number;
  effort_score: number;
  confidence_score: number;
  source_data: string;
}

@Injectable()
export class OpportunityGeneratorService {
  private readonly aiEngineUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.aiEngineUrl = 
      this.configService.get<string>('AI_ENGINE_URL') ??
      'http://localhost:8000';
  }

  /**
   * Le contrat de retour (GeneratedOpportunity[]) ne doit pas changer.
   * Doit toujours retourner entre 3 et 5 opportunités max.
   */
  async generate(
    auditResult: Record<string, any>,
    organizationCity?: string | null,
  ): Promise<GeneratedOpportunity[]> {
    const response = await fetch (`${this.aiEngineUrl}/opportunities`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audit_result: auditResult,
        city: organizationCity,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `AI engine /opportunities failed with status: ${response.status}`,
      );
    }

    return response.json();
  } 
}
