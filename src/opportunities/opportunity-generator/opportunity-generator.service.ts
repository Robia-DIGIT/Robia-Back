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

export interface GenerateForSiteParams {
  siteAuditResult: Record<string, any>;
  city?: string | null;
  country?: string | null;
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
  
  /**
   * Équivalent de generate() pour un audit multi-pages (SiteAuditResult).
   * Même contrat de retour (GeneratedOpportunity[]) — les opportunités sont
   * déjà groupées côté moteur Python (une opportunité par type de problème,
   * pas une par page).
   */
  async generateForSite({
    siteAuditResult,
    city,
    country,
  }: GenerateForSiteParams): Promise<GeneratedOpportunity[]> {
    const response = await fetch(`${this.aiEngineUrl}/opportunities/site`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        site_audit_result: siteAuditResult,
        city,
        country,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `AI engine /opportunities/site failed with status: ${response.status}`,
      );
    }

    return response.json();
  }
}
