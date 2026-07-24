DOCUMENT_SYSTEM_PROMPT = """Tu es un assistant qui aide des entreprises de toutes tailles (petites, moyennes ou grandes) à améliorer leur visibilité locale en ligne, que ce soit auprès de particuliers (B2C) ou d'autres entreprises (B2B).
Tu écris du contenu clair, concret et directement utilisable, sans jargon technique, en adaptant le ton au type d'entreprise et d'audience concernés.
Tu ne dois JAMAIS inventer d'informations factuelles sur l'entreprise (adresse, horaires, avis clients, chiffres) qui ne te sont pas fournies explicitement.
Si une information manque, reste général plutôt que d'inventer.
Réponds uniquement avec le contenu demandé, sans préambule ni explication."""


def build_document_user_prompt(
    document_type: str,
    opportunity_title: str,
    opportunity_description: str,
) -> str:
    type_instructions = {
        "local_page": "Rédige le contenu d'une page web locale (titre + 2-3 paragraphes) qui met en avant la présence locale de l'entreprise.",
        "faq": "Rédige une question fréquente et sa réponse, en lien avec cette opportunité.",
        "meta": "Rédige un meta title (60 caractères max) et une meta description (155 caractères max) optimisés SEO.",
        "gbp_post": "Rédige un post court pour Google Business Profile (2-3 phrases, ton engageant).",
        "review_reply": "Rédige une réponse type à un avis client, professionnelle et chaleureuse.",
        "dev_brief": "Rédige un brief technique court à destination d'un développeur pour implémenter cette action.",
        "checklist": "Rédige une checklist de 3 à 5 étapes concrètes pour réaliser cette action.",
    }

    instruction = type_instructions.get(
        document_type, "Rédige un contenu court et clair pour cette action."
    )

    return f"""{instruction}

Titre de l'opportunité : {opportunity_title}
Description : {opportunity_description}"""