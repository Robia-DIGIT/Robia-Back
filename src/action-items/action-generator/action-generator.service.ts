import { Injectable } from '@nestjs/common';

export interface GeneratedAction {
  title: string;
}

@Injectable()
export class ActionGeneratorService {
  /**
   * TODO: remplacer ce mock par un vrai appel IA suggérant un ordre logique d'exécution.
   * Le contrat de retour (GeneratedAction) ne doit pas changer.
   */
  async generateFromOpportunity(
    opportunityTitle: string,
  ): Promise<GeneratedAction[]> {
    await new Promise((resolve) => setTimeout(resolve, 200));

    return [{ title: `Mettre en œuvre : ${opportunityTitle}` }];
  }
}
