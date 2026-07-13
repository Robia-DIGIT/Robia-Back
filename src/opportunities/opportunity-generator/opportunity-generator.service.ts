import { Injectable } from '@nestjs/common';

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
  /**
   * TODO: remplacer ce mock par un vrai appel au moteur de priorisation IA.
   * Le contrat de retour (GeneratedOpportunity[]) ne doit pas changer.
   * Doit toujours retourner entre 3 et 5 opportunités max.
   */
  async generate(
    auditResult: Record<string, any>,
    organizationCity?: string | null,
  ): Promise<GeneratedOpportunity[]> {
    await new Promise((resolve) => setTimeout(resolve, 300));

    return [
      {
        title: `Créer une page locale pour ${organizationCity ?? 'votre ville'}`,
        description:
          "Votre site ne présente pas clairement votre zone d'intervention locale.",
        category: 'local',
        impact_score: 8,
        effort_score: 3,
        confidence_score: 0.82,
        source_data: `Ville renseignée : ${organizationCity ?? 'non renseignée'}, absence de page locale détectée.`,
      },
      {
        title: 'Connecter votre fiche Google Business Profile',
        description:
          "Aucune donnée GBP n'est disponible pour enrichir votre visibilité locale.",
        category: 'local',
        impact_score: 7,
        effort_score: 2,
        confidence_score: 0.9,
        source_data: 'Données manquantes détectées dans l\'audit : GBP non connecté.',
      },
      {
        title: 'Améliorer les performances techniques du site',
        description:
          'Le sous-score technique indique des marges de progression sur la vitesse ou la structure du site.',
        category: 'technical',
        impact_score: 6,
        effort_score: 5,
        confidence_score: 0.75,
        source_data: `Sous-score technique : ${auditResult?.subscores?.technical ?? 'N/A'}/100.`,
      },
    ];
  }
}
