import json
import re
from app.llm.groq_provider import GroqProvider
from app.prompts.action_generation import (
    ACTION_SYSTEM_PROMPT,
    build_action_user_prompt,
)


def _extract_json_array(text: str) -> list[str]:
    """
    Extrait une liste JSON de chaînes depuis la réponse du LLM,
    même si elle est entourée de texte parasite ou de blocs markdown.
    """
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if not match:
        raise ValueError("Aucun tableau JSON trouvé dans la réponse du LLM")

    parsed = json.loads(match.group(0))
    if not isinstance(parsed, list):
        raise ValueError("La réponse du LLM n'est pas une liste")

    return [str(item).strip() for item in parsed if str(item).strip()]


def generate_actions(
    opportunity_title: str,
    opportunity_description: str,
) -> list[dict]:
    """
    Génère 1 à 3 actions concrètes et ordonnées à partir d'une opportunité.
    Retourne une liste de dicts {"title": str} respectant le contrat GeneratedAction.
    En cas d'échec de parsing, retombe sur une action générique unique
    plutôt que de faire échouer tout le pipeline.
    """
    provider = GroqProvider()
    user_prompt = build_action_user_prompt(opportunity_title, opportunity_description)

    raw_response = provider.generate(ACTION_SYSTEM_PROMPT, user_prompt)

    try:
        titles = _extract_json_array(raw_response)
        if not titles:
            raise ValueError("Liste vide")
    except (ValueError, json.JSONDecodeError):
        titles = [f"Mettre en œuvre : {opportunity_title}"]

    return [{"title": title} for title in titles[:3]]