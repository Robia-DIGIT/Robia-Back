from app.agents.ingestion import scrape_website
from app.agents.analysis import compute_audit_result
from app.agents.prioritization import generate_opportunities
from app.agents.generation import generate_document_content
from app.agents.action_generation import generate_actions


def run_audit(url: str, city: str | None = None) -> dict:
    """
    Point d'entrée unique pour l'audit : scrape puis analyse.
    Retourne un dict respectant exactement le contrat AuditResult.
    """
    page = scrape_website(url)
    return compute_audit_result(page, city)


def run_opportunity_generation(audit_result: dict, city: str | None = None) -> list[dict]:
    """
    Point d'entrée unique pour la génération d'opportunités.
    Retourne une liste de dicts respectant exactement le contrat GeneratedOpportunity.
    """
    return generate_opportunities(audit_result, city)


def run_document_generation(
    document_type: str,
    opportunity_title: str,
    opportunity_description: str,
) -> dict:
    """
    Point d'entrée unique pour la génération de documents via LLM.
    Retourne un dict respectant exactement le contrat GeneratedDocument.
    """
    return generate_document_content(
        document_type, opportunity_title, opportunity_description
    )


def run_action_generation(
    opportunity_title: str,
    opportunity_description: str,
) -> list[dict]:
    """
    Point d'entrée unique pour la génération d'actions via LLM.
    Retourne une liste de dicts respectant exactement le contrat GeneratedAction.
    """
    return generate_actions(opportunity_title, opportunity_description)