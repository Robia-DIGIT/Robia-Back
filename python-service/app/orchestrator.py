from app.agents.ingestion import scrape_website
from app.agents.analysis import compute_audit_result
from app.agents.prioritization import generate_opportunities


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