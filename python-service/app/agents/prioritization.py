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

def generate_site_opportunities(site_audit_result: dict, city: str | None = None, country: str | None = None) -> list[dict]:
    """
    Génère jusqu'à 5 opportunités priorisées à partir d'un audit multi-pages
    (SiteAuditResult). Une seule opportunité par type de problème détecté,
    même si plusieurs pages sont concernées — les URLs affectées sont listées
    dans source_data plutôt que de dupliquer l'opportunité par page.
    Même format de sortie que generate_opportunities(), pour rester
    interchangeable côté consommateurs (NestJS, Document/ActionItem).
    """
    opportunities: list[dict] = []
    pages = site_audit_result.get("pages", [])
    pages_count = site_audit_result.get("pages_count", 0)

    def _affected_urls(predicate) -> list[str]:
        return [p["url"] for p in pages if predicate(p)]

    def _format_source(affected: list[str], label: str) -> str:
        shown = affected[:5]
        text = f"{len(affected)} page(s) sur {pages_count} {label} : {', '.join(shown)}"
        if len(affected) > 5:
            text += f" (+{len(affected) - 5} autres)"
        return text

    missing_meta = _affected_urls(lambda p: not p.get("meta_description"))
    if missing_meta:
        opportunities.append({
            "title": "Ajouter des meta descriptions manquantes",
            "description": (
                "Plusieurs pages de votre site n'ont pas de meta description, "
                "ce qui nuit à leur affichage dans les résultats de recherche."
            ),
            "category": "technical",
            "impact_score": 6,
            "effort_score": 2,
            "confidence_score": 0.9,
            "source_data": _format_source(missing_meta, "sans meta description"),
        })

    missing_schema = _affected_urls(lambda p: not p.get("structured_data_types"))
    if missing_schema:
        opportunities.append({
            "title": "Ajouter des données structurées (schema.org)",
            "description": (
                "Aucune donnée structurée n'est détectée sur plusieurs pages. Les "
                "balises schema.org aident les moteurs et les IA à comprendre et "
                "citer votre contenu avec précision."
            ),
            "category": "ai_readiness",
            "impact_score": 6,
            "effort_score": 4,
            "confidence_score": 0.8,
            "source_data": _format_source(missing_schema, "sans schema.org"),
        })

    missing_og = _affected_urls(lambda p: not p.get("og_tags_present"))
    if missing_og:
        opportunities.append({
            "title": "Ajouter des balises Open Graph",
            "description": (
                "Les balises Open Graph sont absentes sur plusieurs pages, ce qui "
                "dégrade l'aperçu de votre site lors du partage sur les réseaux sociaux."
            ),
            "category": "technical",
            "impact_score": 4,
            "effort_score": 2,
            "confidence_score": 0.85,
            "source_data": _format_source(missing_og, "sans Open Graph"),
        })

    titles = [p.get("title") for p in pages if p.get("title")]
    distinct_titles = set(titles)
    if titles and len(distinct_titles) == 1 and len(titles) > 1:
        opportunities.append({
            "title": "Différencier les titres de page",
            "description": (
                "Toutes les pages de votre site partagent le même titre, ce qui "
                "empêche les moteurs de recherche de distinguer leur contenu respectif."
            ),
            "category": "technical",
            "impact_score": 5,
            "effort_score": 3,
            "confidence_score": 0.9,
            "source_data": f"{len(titles)} pages partagent le titre \"{titles[0]}\".",
        })

    if not site_audit_result.get("business_address"):
        opportunities.append({
            "title": "Ajouter une adresse d'entreprise détectable",
            "description": (
                "Aucune adresse n'a pu être détectée sur votre site, ce qui limite "
                "votre visibilité dans les recherches locales."
            ),
            "category": "local",
            "impact_score": 7,
            "effort_score": 2,
            "confidence_score": 0.85,
            "source_data": "Aucune adresse trouvée (schema.org, iframe Maps, ou lien itinéraire).",
        })
    elif site_audit_result.get("location_precision") in ("approximate", "street"):
        opportunities.append({
            "title": "Préciser l'adresse en données structurées",
            "description": (
                "Une adresse a été détectée en texte libre mais sans coordonnées "
                "précises (schema.org LocalBusiness manquant), ce qui limite votre "
                "référencement local exact."
            ),
            "category": "local",
            "impact_score": 5,
            "effort_score": 3,
            "confidence_score": 0.7,
            "source_data": "Adresse détectée en texte libre, géolocalisation approximative uniquement.",
        })

    if not site_audit_result.get("social_links"):
        opportunities.append({
            "title": "Ajouter des liens vers vos réseaux sociaux",
            "description": "Aucun réseau social n'est détecté sur l'ensemble du site.",
            "category": "local",
            "impact_score": 4,
            "effort_score": 1,
            "confidence_score": 0.9,
            "source_data": "Aucun lien Facebook/Instagram/LinkedIn/etc. trouvé sur les pages crawlées.",
        })

    if city:
        city_lower = city.lower()
        keywords = [k.lower() for k in site_audit_result.get("top_keywords", [])]
        mentioned_in_pages = any(
            city_lower in (p.get("main_content") or "").lower() for p in pages
        )
        if city_lower not in keywords and not mentioned_in_pages:
            opportunities.append({
                "title": f"Créer une page locale pour {city}",
                "description": (
                    "Votre site ne présente pas clairement votre zone d'intervention "
                    "locale, ce qui réduit votre visibilité sur les recherches géolocalisées."
                ),
                "category": "local",
                "impact_score": 8,
                "effort_score": 3,
                "confidence_score": 0.75,
                "source_data": f"Ville renseignée : {city}, absente du contenu et des mots-clés dominants du site.",
            })

    avg_word_count = site_audit_result.get("avg_word_count", 0)
    if avg_word_count and avg_word_count < 300:
        opportunities.append({
            "title": "Enrichir le contenu des pages",
            "description": (
                "Le contenu moyen par page est limité, ce qui réduit la visibilité "
                "sur les moteurs de recherche et les moteurs de réponse IA."
            ),
            "category": "content",
            "impact_score": 5,
            "effort_score": 4,
            "confidence_score": 0.7,
            "source_data": f"Nombre moyen de mots par page : {avg_word_count}.",
        })

    opportunities.sort(key=lambda o: o["impact_score"], reverse=True)
    return opportunities[:5]