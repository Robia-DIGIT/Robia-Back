import re

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

from app.prompts.social_post_generation import (
    SOCIAL_POST_SYSTEM_PROMPT,
    build_social_post_user_prompt,
)

_SOCIAL_POST_ANGLE_LABELS = ["Angle direct", "Angle convivial", "Angle opportunité"]


def generate_social_post_suggestions(
    business_name: str,
    sector: str | None,
    city: str | None,
    weather_description: str,
    temperature_c: float,
    opening_hours_today: str | None,
    top_keywords: list[str],
) -> list[dict]:
    """
    Génère 3 variantes de post réseaux sociaux via le LLM configuré, une par
    angle fixe (direct / convivial / opportunité), contextualisées avec la
    météo, les horaires et les thématiques dominantes du site.
    Retourne une liste de dicts [{"label": str, "content": str}, ...].
    Ne lève jamais d'exception liée au parsing : si le LLM ne respecte pas
    le séparateur attendu, retourne le texte brut comme unique variante.
    """
    provider = get_llm_provider()

    user_prompt = build_social_post_user_prompt(
        business_name=business_name,
        sector=sector,
        city=city,
        weather_description=weather_description,
        temperature_c=temperature_c,
        opening_hours_today=opening_hours_today,
        top_keywords=top_keywords,
    )

    raw_content = provider.generate(SOCIAL_POST_SYSTEM_PROMPT, user_prompt)

    markers = ["ANGLE_DIRECT", "ANGLE_CONVIVIAL", "ANGLE_OPPORTUNITE"]
    pattern = r"\[(" + "|".join(markers) + r")\]"

    chunks = re.split(pattern, raw_content)
    # re.split avec groupe capturant alterne texte-avant / marqueur / texte-après.
    # chunks[0] est le texte avant le premier marqueur (à ignorer).
    found = {}
    for i in range(1, len(chunks), 2):
        marker = chunks[i]
        text = chunks[i + 1].strip() if i + 1 < len(chunks) else ""
        if text:
            found[marker] = text

    if len(found) != len(markers):
        # Le LLM n'a pas respecté le format attendu — on retourne quand même
        # quelque chose d'exploitable plutôt que de planter.
        return [{"label": "Proposition", "content": raw_content.strip()}]

    return [
        {"label": label.replace("ANGLE_", "Angle ").capitalize(), "content": found[marker]}
        for label, marker in zip(_SOCIAL_POST_ANGLE_LABELS, markers)
    ]