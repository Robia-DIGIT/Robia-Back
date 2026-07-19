from app.agents.ingestion import ScrapedPage


def compute_audit_result(page: ScrapedPage, city: str | None) -> dict:
    """
    Calcule un score global et des sous-scores à partir de règles simples
    et vérifiables, sans jamais inventer de données absentes.
    """
    missing_data: list[str] = []

    if not page.accessible:
        return {
            "global_score": 0,
            "subscores": {
                "local": 0,
                "technical": 0,
                "content": 0,
                "performance": 0,
            },
            "missing_data": [
                f"Site inaccessible : {page.error or 'raison inconnue'}",
            ],
            "summary": "Le site n'a pas pu être analysé car il est inaccessible.",
        }

    # --- Sous-score technique ---
    technical_score = 50
    if page.title:
        technical_score += 20
    else:
        missing_data.append("Balise <title> absente")

    if page.meta_description:
        technical_score += 20
    else:
        missing_data.append("Meta description absente")

    if page.status_code == 200:
        technical_score += 10

    technical_score = min(technical_score, 100)

    # --- Sous-score contenu ---
    content_score = 30
    if page.main_content:
        content_length = len(page.main_content)
        if content_length > 500:
            content_score += 40
        elif content_length > 100:
            content_score += 20
        else:
            missing_data.append("Contenu principal très limité")
    else:
        missing_data.append("Aucun contenu principal détecté")

    if city and page.main_content and city.lower() in page.main_content.lower():
        content_score += 30
    elif city:
        missing_data.append(f"Aucune mention de la ville '{city}' détectée sur la page")

    content_score = min(content_score, 100)

    # --- Sous-score local (placeholder tant que GBP n'est pas connecté) ---
    local_score = 30
    missing_data.append("Google Business Profile non connecté")
    missing_data.append("Avis clients non disponibles")

    # --- Sous-score performance (placeholder simple) ---
    performance_score = 60  # sans mesure réelle de vitesse pour l'instant

    global_score = round(
        (local_score + technical_score + content_score + performance_score) / 4
    )

    summary = (
        f"Le site est accessible (HTTP {page.status_code}). "
        f"{'Il manque des informations locales visibles.' if local_score < 50 else 'Les informations locales semblent correctes.'}"
    )

    return {
        "global_score": global_score,
        "subscores": {
            "local": local_score,
            "technical": technical_score,
            "content": content_score,
            "performance": performance_score,
        },
        "missing_data": missing_data,
        "summary": summary,
    }