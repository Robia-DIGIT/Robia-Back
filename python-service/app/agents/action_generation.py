import json
import logging
import re
from app.llm.provider_factory import get_llm_provider
from app.prompts.action_generation import (
    ACTION_SYSTEM_PROMPT,
    build_action_user_prompt,
)

logger = logging.getLogger(__name__)

def _extract_json_array(text: str) -> list[str]:
    """
    Extrait le dernier tableau JSON valide et complet de la réponse du LLM,
    en gérant les crochets imbriqués ou les crochets littéraux dans le texte
    (contrairement à un simple regex non-greedy).
    """
    start_indices = [i for i, c in enumerate(text) if c == "["]
    for start in reversed(start_indices):
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "[":
                depth += 1
            elif text[i] == "]":
                depth -= 1
                if depth == 0:
                    candidate = text[start:i + 1]
                    try:
                        parsed = json.loads(candidate)
                        if isinstance(parsed, list) and all(isinstance(item, str) for item in parsed):
                            cleaned = [item.strip() for item in parsed if item.strip()]
                            if cleaned:
                                return cleaned
                    except json.JSONDecodeError:
                        break
                    break
    raise ValueError("Aucun tableau JSON valide trouvé dans la réponse du LLM")

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
    provider = get_llm_provider()
    user_prompt = build_action_user_prompt(opportunity_title, opportunity_description)

    raw_response = provider.generate(ACTION_SYSTEM_PROMPT, user_prompt)

    try:
        titles = _extract_json_array(raw_response)
        if not titles:
            raise ValueError("Liste vide")
    except (ValueError, json.JSONDecodeError):
        titles = [f"Mettre en œuvre : {opportunity_title}"]

    return [{"title": title} for title in titles[:3]]