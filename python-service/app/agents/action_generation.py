import json
import logging
import re
from app.llm.groq_provider import GroqProvider
from app.prompts.action_generation import (
    ACTION_SYSTEM_PROMPT,
    build_action_user_prompt,
)

logger = logging.getLogger(__name__)

def _extract_json_array(text: str) -> list[str]:
    """
    Extrait la liste JSON de chaînes depuis la réponse du LLM.
    Les modèles de raisonnement (comme qwen) génèrent souvent plusieurs
    brouillons de tableaux JSON dans leur réflexion avant la réponse finale.
    On teste tous les candidats et on garde le DERNIER qui parse correctement
    (la réponse finale arrive toujours en dernier).
    """
    candidates = re.findall(r"\[.*?\]", text, re.DOTALL)

    for candidate in reversed(candidates):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, list) and all(
                isinstance(item, str) for item in parsed
            ):
                cleaned = [item.strip() for item in parsed if item.strip()]
                if cleaned:
                    return cleaned
        except json.JSONDecodeError:
            continue

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
    provider = GroqProvider()
    user_prompt = build_action_user_prompt(opportunity_title, opportunity_description)

    raw_response = provider.generate(ACTION_SYSTEM_PROMPT, user_prompt)
    print(f"RAW LLM RESPONSE: {raw_response}", flush=True)

    try:
        titles = _extract_json_array(raw_response)
        if not titles:
            raise ValueError("Liste vide")
    except (ValueError, json.JSONDecodeError) as e:
        print(f"PARSING FAILED: {e}", flush=True)
        titles = [f"Mettre en œuvre : {opportunity_title}"]

    return [{"title": title} for title in titles[:3]]