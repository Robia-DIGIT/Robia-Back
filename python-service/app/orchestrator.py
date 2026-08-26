from app.agents.ingestion import scrape_website, crawl_website, aggregate_site
from app.agents.analysis import compute_audit_result, _analyze_ai_readiness
from app.agents.prioritization import generate_opportunities, generate_site_opportunities
from app.agents.generation import generate_document_content
from app.agents.action_generation import generate_actions


def run_audit(url: str, sector: str | None = None, city: str | None = None, country: str | None = None) -> dict:
    """
    Point d'entrée unique pour l'audit : scrape, raisonne sur l'AI-readiness,
    puis calcule le score global.
    Retourne un dict respectant exactement le contrat AuditResult.
    """
    page = scrape_website(url)
    ai_readiness = _analyze_ai_readiness(page=page, sector=sector, country=country)
    return compute_audit_result(page=page, city=city, country=country, ai_readiness=ai_readiness)


def run_opportunity_generation(audit_result: dict, city: str | None = None) -> list[dict]:
    """
    Point d'entrée unique pour la génération d'opportunités.
    Retourne une liste de dicts respectant exactement le contrat GeneratedOpportunity.
    """
    return generate_opportunities(audit_result, city)


def run_site_opportunity_generation(site_audit_result: dict, city: str | None = None, country: str | None = None) -> list[dict]:
    """
    Point d'entrée pour la génération d'opportunités à partir d'un audit
    multi-pages. Retourne une liste de dicts respectant exactement le
    contrat GeneratedOpportunity (identique à run_opportunity_generation()).
    """
    return generate_site_opportunities(site_audit_result, city, country)


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

def run_site_audit(url: str, max_pages: int = 20, max_depth: int = 2, city: str | None = None, country: str | None = None) -> dict:
    """
    Point d'entrée pour l'audit multi-pages : crawl le site, agrège les
    signaux, et retourne le détail complet de chaque page (pour persistance
    NestJS dans WebPage) + les métriques agrégées du site.
    """
    site = crawl_website(url, max_pages=max_pages, max_depth=max_depth)
    analysis = aggregate_site(site, city=city, country=country)

    pages_detail = [
        {
            "url": p.requested_url or p.final_url or url,
            "accessible": p.accessible,
            "status_code": p.status_code,
            "title": p.title,
            "meta_description": p.meta_description,
            "h1": p.h1,
            "h2": p.h2,
            "h3": p.h3,
            "canonical": p.canonical,
            "meta_robots": p.meta_robots,
            "word_count": p.word_count,
            "images_count": p.images_count,
            "images_without_alt": p.images_without_alt,
            "internal_links_count": p.internal_links_count,
            "external_links_count": p.external_links_count,
            "structured_data_types": p.structured_data_types,
            "og_tags_present": p.og_tags_present,
            "top_keywords": p.top_keywords,
            "business_address": p.business_address,
            "business_latitude": p.business_latitude,
            "business_longitude": p.business_longitude,
            "social_links": p.social_links,
            "js_rendering_used": p.js_rendering_used,
            "js_rendering_suspected": p.js_rendering_suspected,
            "main_content": p.main_content,
            "error": p.error,
        }
        for p in site.pages
    ]

    return {
        "base_url": analysis.base_url,
        "discovery_method": site.discovery_method,
        "pages_discovered": len(site.discovered_urls),
        "pages_analyzed": len(site.pages),
        "pages_failed": len(site.failed_urls),
        "pages_excluded": len(site.excluded_urls),
        "pages_count": analysis.pages_count,
        "pages_with_h1": analysis.pages_with_h1,
        "pages_without_h1": analysis.pages_without_h1,
        "pages_with_meta_description": analysis.pages_with_meta_description,
        "pages_without_meta_description": analysis.pages_without_meta_description,
        "pages_with_schema": analysis.pages_with_schema,
        "pages_without_schema": analysis.pages_without_schema,
        "pages_with_og": analysis.pages_with_og,
        "pages_without_og": analysis.pages_without_og,
        "avg_word_count": analysis.avg_word_count,
        "business_address": analysis.business_address,
        "business_latitude": analysis.business_latitude,
        "business_longitude": analysis.business_longitude,
        "location_precision": analysis.location_precision,
        "social_links": analysis.social_links,
        "top_keywords": analysis.top_keywords,
        "findings": analysis.findings,
        "pages": pages_detail,
        "failed_urls": site.failed_urls,
    }