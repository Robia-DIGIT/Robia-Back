def generate_opportunities(audit_result: dict, city: str | None) -> list[dict]:
    """
    Génère 3 à 5 opportunités priorisées à partir du résultat d'audit.
    Version déterministe pour l'instant (règles), LLM branché plus tard
    pour enrichir la justification en langage naturel.
    """
    opportunities: list[dict] = []
    missing_data = audit_result.get("missing_data", [])
    subscores = audit_result.get("subscores", {})

    if any("ville" in m.lower() for m in missing_data) and city:
        opportunities.append(
            {
                "title": f"Créer une page locale pour {city}",
                "description": "Votre site ne présente pas clairement votre zone d'intervention locale.",
                "category": "local",
                "impact_score": 8,
                "effort_score": 3,
                "confidence_score": 0.82,
                "source_data": f"Ville renseignée : {city}, absence de page locale détectée.",
            }
        )

    if any("google business profile" in m.lower() for m in missing_data):
        opportunities.append(
            {
                "title": "Connecter votre fiche Google Business Profile",
                "description": "Aucune donnée GBP n'est disponible pour enrichir votre visibilité locale.",
                "category": "local",
                "impact_score": 7,
                "effort_score": 2,
                "confidence_score": 0.9,
                "source_data": "Données manquantes détectées dans l'audit : GBP non connecté.",
            }
        )

    if any("meta description" in m.lower() for m in missing_data):
        opportunities.append(
            {
                "title": "Ajouter une meta description optimisée",
                "description": "La meta description est absente, ce qui nuit à l'affichage dans les résultats de recherche.",
                "category": "technical",
                "impact_score": 6,
                "effort_score": 1,
                "confidence_score": 0.95,
                "source_data": "Balise meta description non détectée lors du scraping.",
            }
        )

    technical_score = subscores.get("technical", 100)
    if technical_score < 80:
        opportunities.append(
            {
                "title": "Améliorer les performances techniques du site",
                "description": "Le sous-score technique indique des marges de progression sur la structure du site.",
                "category": "technical",
                "impact_score": 6,
                "effort_score": 5,
                "confidence_score": 0.75,
                "source_data": f"Sous-score technique : {technical_score}/100.",
            }
        )

    content_score = subscores.get("content", 100)
    if content_score < 70:
        opportunities.append(
            {
                "title": "Enrichir le contenu principal du site",
                "description": "Le contenu détecté est limité, ce qui réduit la visibilité sur les moteurs de recherche.",
                "category": "content",
                "impact_score": 5,
                "effort_score": 4,
                "confidence_score": 0.7,
                "source_data": f"Sous-score contenu : {content_score}/100.",
            }
        )

    # Toujours garder entre 3 et 5, triées par impact décroissant
    opportunities.sort(key=lambda o: o["impact_score"], reverse=True)
    return opportunities[:5] if len(opportunities) >= 3 else opportunities