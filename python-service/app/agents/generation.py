from app.llm.provider_factory import get_llm_provider
from app.prompts.document_generation import (
    DOCUMENT_SYSTEM_PROMPT,
    build_document_user_prompt,
)


def generate_document_content(
    document_type: str,
    opportunity_title: str,
    opportunity_description: str,
) -> dict:
    """
    Génère le contenu d'un document via le LLM configuré.
    Retourne un dict {"title": str, "content": str} respectant
    le contrat GeneratedDocument.
    """
    provider = get_llm_provider()

    user_prompt = build_document_user_prompt(
        document_type, opportunity_title, opportunity_description
    )

    content = provider.generate(DOCUMENT_SYSTEM_PROMPT, user_prompt)

    return {
        "title": f"{document_type} — {opportunity_title}",
        "content": content.strip(),
    }