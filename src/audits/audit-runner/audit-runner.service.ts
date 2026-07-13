/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';

export interface AuditResult {
  global_score: number;
  subscores: {
    local: number;
    technical: number;
    content: number;
    performance: number;
  };
  missing_data: string[];
  summary: string;
}

@Injectable()
export class AuditRunnerService {
  /**
   * TODO: remplacer ce mock par un vrai appel HTTP au service Python
   * (POST vers le service IA avec { url, sector, city }).
   * Le contrat de retour (AuditResult) ne doit pas changer.
   */
  async runAudit(websiteUrl: string): Promise<AuditResult> {
    // Simulation d'un délai réseau réaliste
    await new Promise((resolve) => setTimeout(resolve, 500));

    return {
      global_score: 62,
      subscores: {
        local: 55,
        technical: 70,
        content: 60,
        performance: 65,
      },
      missing_data: [
        'Google Business Profile non connecté',
        'Avis clients non disponibles',
      ],
      summary: `Analyse simulée pour ${websiteUrl} : le site est accessible mais manque d'informations locales visibles.`,
    };
  }
}