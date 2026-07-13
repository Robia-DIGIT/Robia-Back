import { Injectable } from '@nestjs/common';

export interface GeneratedDocument {
  title: string;
  content: string;
}

@Injectable()
export class DocumentGeneratorService {
  /**
   * TODO: remplacer ce mock par un vrai appel au service Python/IA de génération.
   * Le contrat de retour (GeneratedDocument) ne doit pas changer.
   * Règle absolue héritée du backlog : ne jamais inventer de données absentes.
   */
  async generate(
    type: string,
    opportunityTitle: string,
    opportunityDescription: string,
  ): Promise<GeneratedDocument> {
    await new Promise((resolve) => setTimeout(resolve, 300));

    const templates: Record<string, GeneratedDocument> = {
      local_page: {
        title: `Page locale — ${opportunityTitle}`,
        content: `# ${opportunityTitle}\n\n${opportunityDescription}\n\nCe contenu est une ébauche générée automatiquement. Merci de le relire et de l'adapter avant publication.`,
      },
      faq: {
        title: `FAQ — ${opportunityTitle}`,
        content: `**Question fréquente liée à : ${opportunityTitle}**\n\n${opportunityDescription}\n\n(Contenu à compléter avec vos informations spécifiques.)`,
      },
      meta: {
        title: `Meta title/description — ${opportunityTitle}`,
        content: `Title: ${opportunityTitle} | Votre entreprise\nDescription: ${opportunityDescription}`,
      },
      gbp_post: {
        title: `Post GBP — ${opportunityTitle}`,
        content: ` ${opportunityTitle}\n\n${opportunityDescription}`,
      },
      review_reply: {
        title: `Réponse type — ${opportunityTitle}`,
        content: `Merci pour votre retour. ${opportunityDescription}`,
      },
      dev_brief: {
        title: `Brief développeur — ${opportunityTitle}`,
        content: `## Contexte\n${opportunityDescription}\n\n## Action attendue\nÀ définir avec l'équipe technique.`,
      },
      checklist: {
        title: `Checklist — ${opportunityTitle}`,
        content: `- [ ] ${opportunityDescription}\n- [ ] Valider avec l'équipe\n- [ ] Publier`,
      },
    };

    return (
      templates[type] ?? {
        title: opportunityTitle,
        content: opportunityDescription,
      }
    );
  }
}
