def generate_opportunities(audit_result: dict, city: str | None) -> list[dict]:
    """
    Génère jusqu'à 5 opportunités priorisées à partir du résultat d'audit.
    Version déterministe pour l'instant (règles), LLM branché plus tard
    pour enrichir la justification en langage naturel.
    """
    opportunities: list[dict] = []
    missing_data = audit_result.get("missing_data", [])
    subscores = audit_result.get("subscores", {})
    breakdown = audit_result.get("ai_readiness_breakdown", {})
    technical_details = audit_result.get("technical_details", {})

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

    # --- ai_readiness : découpé en règles ciblées grâce au breakdown ---
    # Plutôt qu'une seule opportunité vague "optimiser pour l'IA", on cible
    # précisément le sous-critère le plus faible.
    authority_score = breakdown.get("authority", 100)
    if authority_score < 60:
        authority_gaps = [
            m for m in missing_data
            if any(k in m.lower() for k in ["date de", "source", "auteur", "expertise", "référence"])
        ]
        gaps_text = ", ".join(authority_gaps) if authority_gaps else "signaux d'autorité insuffisants"
        opportunities.append(
            {
                "title": "Renforcer les signaux d'autorité (E-E-A-T)",
                "description": (
                    "Votre contenu manque de signaux de crédibilité (auteur, date, sources) "
                    "qui aident les IA génératives à évaluer la fiabilité de vos informations."
                ),
                "category": "ai_readiness",
                "impact_score": 7,
                "effort_score": 3,
                "confidence_score": 0.8,
                "source_data": f"Sous-score autorité : {authority_score}/100. Lacunes : {gaps_text}.",
            }
        )

    structure_score = breakdown.get("structure", 100)
    if structure_score < 60:
        opportunities.append(
            {
                "title": "Restructurer le contenu pour l'extraction par IA",
                "description": (
                    "La hiérarchie de titres et le format Q&A de votre page ne sont pas "
                    "optimaux pour être cités par les moteurs de réponse IA."
                ),
                "category": "ai_readiness",
                "impact_score": 6,
                "effort_score": 4,
                "confidence_score": 0.75,
                "source_data": f"Sous-score structure : {structure_score}/100.",
            }
        )

    # --- Nouvelle règle : données structurées absentes ou incomplètes ---
    schema_types = technical_details.get("schema_org_types", [])
    if not schema_types:
        opportunities.append(
            {
                "title": "Ajouter des données structurées (schema.org)",
                "description": (
                    "Aucune donnée structurée n'est détectée sur votre page. Les balises "
                    "schema.org aident les moteurs de recherche et les IA à comprendre "
                    "et citer votre contenu avec précision."
                ),
                "category": "ai_readiness",
                "impact_score": 6,
                "effort_score": 3,
                "confidence_score": 0.85,
                "source_data": "Aucun type schema.org détecté dans le HTML de la page.",
            }
        )
    elif "FAQPage" not in schema_types and any("faq" in m.lower() or "q&a" in m.lower() for m in missing_data):
        opportunities.append(
            {
                "title": "Ajouter un schema FAQPage",
                "description": (
                    "Votre page contient du contenu de type FAQ mais sans balisage "
                    "structuré FAQPage, ce qui limite son affichage enrichi dans les résultats."
                ),
                "category": "ai_readiness",
                "impact_score": 5,
                "effort_score": 2,
                "confidence_score": 0.7,
                "source_data": f"Types schema.org détectés : {', '.join(schema_types)} (FAQPage absent).",
            }
        )

    # --- Nouvelle règle : performance basée sur le temps de réponse réel ---
    response_time = technical_details.get("response_time_ms")
    if response_time is not None and response_time > 2000:
        opportunities.append(
            {
                "title": "Améliorer le temps de chargement de la page",
                "description": (
                    "Le temps de réponse de votre site est supérieur aux recommandations "
                    "(2.5s pour un bon LCP), ce qui peut pénaliser votre classement."
                ),
                "category": "performance",
                "impact_score": 6,
                "effort_score": 5,
                "confidence_score": 0.85,
                "source_data": f"Temps de réponse mesuré : {response_time:.0f}ms.",
            }
        )

    # --- Fallback générique si aucun critère ai_readiness spécifique n'a matché ---
    # (garde l'ancienne règle globale comme filet de sécurité)
    ai_readiness_score = subscores.get("ai_readiness", 100)
    has_ai_opportunity = any(o["category"] == "ai_readiness" for o in opportunities)
    if ai_readiness_score < 60 and not has_ai_opportunity:
        opportunities.append(
            {
                "title": "Optimiser le contenu pour les moteurs de réponse IA",
                "description": (
                    "Votre contenu manque de structure et de signaux d'autorité "
                    "exploitables par les IA génératives (ChatGPT, Perplexity, Google AI Overviews)."
                ),
                "category": "ai_readiness",
                "impact_score": 7,
                "effort_score": 4,
                "confidence_score": 0.8,
                "source_data": f"Sous-score ai_readiness : {ai_readiness_score}/100.",
            }
        )

    opportunities.sort(key=lambda o: o["impact_score"], reverse=True)
    return opportunities[:5]