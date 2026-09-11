from __future__ import annotations

from collections import Counter
from typing import Any


SEVERITY_WEIGHTS = {
    "info": 0,
    "low": 8,
    "medium": 14,
    "high": 22,
    "critical": 30,
}


def _page_url(page: dict[str, Any]) -> str:
    return str(page.get("url") or "URL inconnue")


def _priority_score(
    status: str,
    severity: str,
    impact_score: int,
    effort_score: int,
    confidence_score: float,
) -> int:
    if status not in {"failed", "warning"}:
        return 0
    raw = (
        SEVERITY_WEIGHTS[severity]
        + impact_score * 6
        + round(confidence_score * 10)
        - max(effort_score - 1, 0) * 3
    )
    return max(1, min(100, raw))


def _finding(
    *,
    rule_code: str,
    title: str,
    category: str,
    status: str,
    severity: str,
    impact_score: int,
    effort_score: int,
    confidence_score: float,
    affected_urls: list[str],
    evidence: list[dict[str, str]],
    source_data: str,
    why_it_matters: str,
    recommended_steps: list[str],
) -> dict[str, Any]:
    return {
        "rule_code": rule_code,
        "title": title,
        "category": category,
        "status": status,
        "severity": severity,
        "impact_score": impact_score,
        "effort_score": effort_score,
        "confidence_score": confidence_score,
        "priority_score": _priority_score(
            status,
            severity,
            impact_score,
            effort_score,
            confidence_score,
        ),
        "affected_urls": affected_urls,
        "evidence": evidence,
        "source_data": source_data,
        "why_it_matters": why_it_matters,
        "recommended_steps": recommended_steps,
    }


def _page_rule(
    *,
    pages: list[dict[str, Any]],
    predicate,
    rule_code: str,
    title: str,
    category: str,
    severity: str,
    impact_score: int,
    effort_score: int,
    confidence_score: float,
    observed,
    expected: str,
    failed_summary: str,
    passed_summary: str,
    why_it_matters: str,
    recommended_steps: list[str],
) -> dict[str, Any]:
    affected = [page for page in pages if predicate(page)]
    affected_urls = [_page_url(page) for page in affected]
    evidence = [
        {
            "url": _page_url(page),
            "observed": str(observed(page)),
            "expected": expected,
        }
        for page in affected[:20]
    ]
    status = "failed" if affected else "passed"
    summary = (
        f"{len(affected)} page(s) sur {len(pages)} {failed_summary}."
        if affected
        else f"{len(pages)} page(s) contrôlée(s) : {passed_summary}."
    )
    return _finding(
        rule_code=rule_code,
        title=title,
        category=category,
        status=status,
        severity=severity if affected else "info",
        impact_score=impact_score if affected else 0,
        effort_score=effort_score if affected else 0,
        confidence_score=confidence_score,
        affected_urls=affected_urls,
        evidence=evidence,
        source_data=summary,
        why_it_matters=why_it_matters if affected else "",
        recommended_steps=recommended_steps if affected else [],
    )


def evaluate_performance(
    psi_result: dict[str, Any] | None,
    base_url: str,
) -> dict[str, Any]:
    """Turn a PageSpeed Insights (mobile) result into a performance finding.

    ``psi_result`` is ``None`` whenever PSI is unavailable (no API key,
    network failure, quota, timeout) — this always returns a well-formed
    finding, using status "not_tested" in that case, so performance is
    never silently missing from the audit.
    """
    if not psi_result:
        return _finding(
            rule_code="performance.pagespeed_insights",
            title="Mesurer la performance mobile réelle",
            category="performance",
            status="not_tested",
            severity="info",
            impact_score=0,
            effort_score=0,
            confidence_score=0.0,
            affected_urls=[],
            evidence=[],
            source_data=(
                "Contrôle non exécuté : Google PageSpeed Insights est "
                "indisponible ou aucune clé API n'est configurée."
            ),
            why_it_matters="",
            recommended_steps=[],
        )

    score = psi_result.get("performance_score")
    lcp_ms = psi_result.get("lcp_ms")
    cls = psi_result.get("cls")
    tbt_ms = psi_result.get("tbt_ms")

    if score is None or score >= 90:
        status, severity, impact_score, effort_score = "passed", "info", 0, 0
    elif score >= 50:
        status, severity, impact_score, effort_score = "warning", "medium", 5, 3
    else:
        status, severity, impact_score, effort_score = "failed", "high", 8, 3

    evidence = [
        {
            "url": base_url,
            "observed": f"Score de performance mobile : {score}/100",
            "expected": "Score supérieur ou égal à 90/100",
        }
    ]
    if lcp_ms is not None:
        evidence.append(
            {
                "url": base_url,
                "observed": f"Largest Contentful Paint (LCP) : {lcp_ms / 1000:.1f}s",
                "expected": "LCP inférieur à 2.5s",
            }
        )
    if cls is not None:
        evidence.append(
            {
                "url": base_url,
                "observed": f"Cumulative Layout Shift (CLS) : {cls:.2f}",
                "expected": "CLS inférieur à 0.10",
            }
        )
    if tbt_ms is not None:
        evidence.append(
            {
                "url": base_url,
                "observed": f"Total Blocking Time (TBT) : {tbt_ms:.0f}ms",
                "expected": "TBT inférieur à 200ms",
            }
        )

    recommended_steps: list[str] = []
    if status != "passed":
        if lcp_ms is not None and lcp_ms >= 2500:
            recommended_steps.append(
                "Accélérer le chargement de l'élément principal de la page "
                "(compresser les images, réduire le temps de réponse serveur)."
            )
        if cls is not None and cls >= 0.1:
            recommended_steps.append(
                "Réserver l'espace des images et des blocs dynamiques pour "
                "éviter les décalages de mise en page pendant le chargement."
            )
        if tbt_ms is not None and tbt_ms >= 200:
            recommended_steps.append(
                "Réduire ou différer le JavaScript qui bloque l'interactivité "
                "de la page."
            )
        if not recommended_steps:
            recommended_steps.append(
                "Analyser le rapport PageSpeed Insights détaillé pour "
                "identifier les optimisations les plus impactantes."
            )

    return _finding(
        rule_code="performance.pagespeed_insights",
        title="Améliorer la performance mobile réelle",
        category="performance",
        status=status,
        severity=severity,
        impact_score=impact_score,
        effort_score=effort_score,
        confidence_score=0.9,
        affected_urls=[base_url] if status != "passed" else [],
        evidence=evidence,
        source_data=f"Score de performance mobile PageSpeed Insights : {score}/100.",
        why_it_matters=(
            "Une page mobile lente augmente l'abandon des visiteurs et peut "
            "pénaliser le classement local, en particulier pour des "
            "recherches faites en déplacement."
            if status != "passed"
            else ""
        ),
        recommended_steps=recommended_steps,
    )


def evaluate_site_audit(
    site_audit_result: dict[str, Any],
    city: str | None = None,
    country: str | None = None,
    psi_result: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Return transparent, deterministic SEO checks for a multi-page audit."""
    pages = [
        page for page in site_audit_result.get("pages", [])
        if isinstance(page, dict)
    ]
    findings: list[dict[str, Any]] = []

    failed_urls = [
        str(url) for url in site_audit_result.get("failed_urls", []) if url
    ]
    findings.append(
        _finding(
            rule_code="technical.http_access",
            title="Corriger les pages inaccessibles",
            category="technical",
            status="failed" if failed_urls else "passed",
            severity="critical" if failed_urls else "info",
            impact_score=9 if failed_urls else 0,
            effort_score=4 if failed_urls else 0,
            confidence_score=1.0,
            affected_urls=failed_urls,
            evidence=[
                {
                    "url": url,
                    "observed": "La page n'a pas pu être récupérée pendant le crawl",
                    "expected": "Réponse HTTP accessible et indexable",
                }
                for url in failed_urls[:20]
            ],
            source_data=(
                f"{len(failed_urls)} URL(s) inaccessible(s) pendant le crawl."
                if failed_urls
                else "Toutes les URLs analysées étaient accessibles."
            ),
            why_it_matters=(
                "Une page inaccessible ne peut pas être correctement explorée "
                "ni présentée dans les résultats de recherche."
                if failed_urls else ""
            ),
            recommended_steps=(
                [
                    "Contrôler le code HTTP de chaque URL affectée.",
                    "Corriger la page, le lien interne ou la redirection concernée.",
                    "Relancer l'audit pour confirmer une réponse accessible.",
                ]
                if failed_urls else []
            ),
        )
    )

    findings.extend(
        [
            _page_rule(
                pages=pages,
                predicate=lambda p: not str(p.get("title") or "").strip(),
                rule_code="on_page.title_missing",
                title="Ajouter les balises title manquantes",
                category="technical",
                severity="high",
                impact_score=8,
                effort_score=2,
                confidence_score=0.99,
                observed=lambda _p: "Balise <title> absente ou vide",
                expected="Une balise <title> unique et descriptive",
                failed_summary="sans balise title exploitable",
                passed_summary="balise title présente",
                why_it_matters=(
                    "Le titre aide Google et l'utilisateur à comprendre le sujet "
                    "principal de chaque page."
                ),
                recommended_steps=[
                    "Définir un titre unique pour chaque URL affectée.",
                    "Inclure le service ou sujet principal et la localisation pertinente.",
                    "Conserver un titre lisible, spécifique et non dupliqué.",
                ],
            ),
            _page_rule(
                pages=pages,
                predicate=lambda p: not str(p.get("meta_description") or "").strip(),
                rule_code="on_page.meta_description_missing",
                title="Ajouter les meta descriptions manquantes",
                category="technical",
                severity="medium",
                impact_score=6,
                effort_score=2,
                confidence_score=0.99,
                observed=lambda _p: "Meta description absente ou vide",
                expected="Une description unique qui résume la page",
                failed_summary="sans meta description",
                passed_summary="meta description présente",
                why_it_matters=(
                    "Une description précise améliore la compréhension du résultat "
                    "et peut augmenter le taux de clic."
                ),
                recommended_steps=[
                    "Rédiger une description spécifique pour chaque URL affectée.",
                    "Présenter le bénéfice principal et l'intention de la page.",
                    "Éviter les descriptions identiques entre plusieurs pages.",
                ],
            ),
            _page_rule(
                pages=pages,
                predicate=lambda p: not p.get("h1"),
                rule_code="on_page.h1_missing",
                title="Ajouter les titres H1 manquants",
                category="technical",
                severity="high",
                impact_score=7,
                effort_score=2,
                confidence_score=0.99,
                observed=lambda _p: "Aucun H1 détecté",
                expected="Un H1 principal clair",
                failed_summary="sans titre H1",
                passed_summary="H1 présent",
                why_it_matters=(
                    "Le H1 structure la page et confirme son sujet principal aux "
                    "moteurs de recherche comme aux visiteurs."
                ),
                recommended_steps=[
                    "Ajouter un H1 visible sur chaque page affectée.",
                    "Faire correspondre le H1 à l'intention et au contenu réel de la page.",
                    "Ne pas utiliser le logo ou un texte générique comme H1.",
                ],
            ),
            _page_rule(
                pages=pages,
                predicate=lambda p: len(p.get("h1") or []) > 1,
                rule_code="on_page.h1_multiple",
                title="Clarifier les pages avec plusieurs H1",
                category="technical",
                severity="low",
                impact_score=4,
                effort_score=2,
                confidence_score=0.95,
                observed=lambda p: f"{len(p.get('h1') or [])} H1 détectés",
                expected="Un sujet principal clairement identifiable",
                failed_summary="avec plusieurs H1",
                passed_summary="aucune ambiguïté liée à plusieurs H1",
                why_it_matters=(
                    "Plusieurs H1 ne sont pas toujours bloquants, mais peuvent rendre "
                    "la hiérarchie éditoriale ambiguë."
                ),
                recommended_steps=[
                    "Vérifier que chaque H1 représente réellement le sujet principal.",
                    "Convertir les titres secondaires en H2 lorsque nécessaire.",
                ],
            ),
            _page_rule(
                pages=pages,
                predicate=lambda p: not str(p.get("canonical") or "").strip(),
                rule_code="indexability.canonical_missing",
                title="Déclarer les URLs canoniques",
                category="technical",
                severity="medium",
                impact_score=6,
                effort_score=2,
                confidence_score=0.98,
                observed=lambda _p: "Balise canonical absente",
                expected="Une canonical absolue vers la version préférée de la page",
                failed_summary="sans balise canonical",
                passed_summary="canonical présente",
                why_it_matters=(
                    "La canonical aide les moteurs à choisir la bonne URL lorsque "
                    "plusieurs variantes du même contenu existent."
                ),
                recommended_steps=[
                    "Ajouter une canonical absolue sur chaque URL affectée.",
                    "Pointer vers l'URL indexable préférée.",
                    "Vérifier que la cible renvoie HTTP 200.",
                ],
            ),
            _page_rule(
                pages=pages,
                predicate=lambda p: "noindex" in str(p.get("meta_robots") or "").lower(),
                rule_code="indexability.noindex",
                title="Vérifier les pages exclues de l'index",
                category="technical",
                severity="high",
                impact_score=8,
                effort_score=2,
                confidence_score=0.99,
                observed=lambda p: f"meta robots : {p.get('meta_robots')}",
                expected="Directive index pour les pages destinées à Google",
                failed_summary="déclarée(s) noindex",
                passed_summary="aucune directive noindex détectée",
                why_it_matters=(
                    "Une page noindex ne peut pas apparaître dans les résultats Google. "
                    "L'exclusion doit donc être volontaire."
                ),
                recommended_steps=[
                    "Confirmer si chaque exclusion est volontaire.",
                    "Retirer noindex des pages qui doivent apparaître dans Google.",
                    "Relancer l'inspection et l'audit après publication.",
                ],
            ),
            _page_rule(
                pages=pages,
                predicate=lambda p: int(p.get("images_without_alt") or 0) > 0,
                rule_code="content.image_alt_missing",
                title="Décrire les images importantes",
                category="content",
                severity="medium",
                impact_score=5,
                effort_score=3,
                confidence_score=0.98,
                observed=lambda p: (
                    f"{int(p.get('images_without_alt') or 0)} image(s) sans alt "
                    f"sur {int(p.get('images_count') or 0)}"
                ),
                expected="Texte alternatif utile pour chaque image informative",
                failed_summary="contenant des images sans texte alternatif",
                passed_summary="aucune image informative sans alt détectée",
                why_it_matters=(
                    "Les textes alternatifs améliorent l'accessibilité et donnent du "
                    "contexte aux moteurs pour les images informatives."
                ),
                recommended_steps=[
                    "Identifier les images informatives des URLs affectées.",
                    "Ajouter une description courte et fidèle à leur contenu.",
                    "Laisser un alt vide uniquement pour les images décoratives.",
                ],
            ),
            _page_rule(
                pages=pages,
                predicate=lambda p: not p.get("structured_data_types"),
                rule_code="structured_data.missing",
                title="Ajouter les données structurées pertinentes",
                category="ai_readiness",
                severity="medium",
                impact_score=6,
                effort_score=4,
                confidence_score=0.95,
                observed=lambda _p: "Aucun type schema.org détecté",
                expected="Données structurées valides adaptées au contenu",
                failed_summary="sans donnée structurée détectable",
                passed_summary="données structurées détectées",
                why_it_matters=(
                    "Les données structurées facilitent la compréhension des entités, "
                    "services et contenus par les moteurs."
                ),
                recommended_steps=[
                    "Choisir les types schema.org réellement adaptés à la page.",
                    "Ajouter un JSON-LD cohérent avec le contenu visible.",
                    "Valider le balisage puis relancer l'audit.",
                ],
            ),
            _page_rule(
                pages=pages,
                predicate=lambda p: 0 < int(p.get("word_count") or 0) < 300,
                rule_code="content.thin_page",
                title="Enrichir les pages au contenu insuffisant",
                category="content",
                severity="medium",
                impact_score=6,
                effort_score=4,
                confidence_score=0.75,
                observed=lambda p: f"{int(p.get('word_count') or 0)} mots détectés",
                expected="Un contenu suffisant pour répondre clairement à l'intention",
                failed_summary="avec moins de 300 mots exploitables",
                passed_summary="aucune page manifestement pauvre détectée",
                why_it_matters=(
                    "Un contenu trop limité répond rarement de façon complète à "
                    "l'intention de recherche ciblée."
                ),
                recommended_steps=[
                    "Clarifier l'intention principale de chaque URL affectée.",
                    "Ajouter les informations utiles absentes, sans remplissage artificiel.",
                    "Structurer la réponse avec des sous-titres et exemples pertinents.",
                ],
            ),
        ]
    )

    titles_by_value: dict[str, list[str]] = {}
    for page in pages:
        title = str(page.get("title") or "").strip()
        if title:
            titles_by_value.setdefault(title.casefold(), []).append(_page_url(page))
    duplicates = {
        title: urls for title, urls in titles_by_value.items() if len(urls) > 1
    }
    duplicate_urls = [url for urls in duplicates.values() for url in urls]
    findings.append(
        _finding(
            rule_code="on_page.title_duplicate",
            title="Différencier les titres dupliqués",
            category="technical",
            status="failed" if duplicates else "passed",
            severity="medium" if duplicates else "info",
            impact_score=6 if duplicates else 0,
            effort_score=3 if duplicates else 0,
            confidence_score=0.99,
            affected_urls=duplicate_urls,
            evidence=[
                {
                    "url": ", ".join(urls),
                    "observed": f"Titre partagé : {title}",
                    "expected": "Un titre unique par intention de page",
                }
                for title, urls in list(duplicates.items())[:20]
            ],
            source_data=(
                f"{len(duplicate_urls)} page(s) utilisent un titre déjà présent."
                if duplicates
                else "Aucun titre dupliqué détecté."
            ),
            why_it_matters=(
                "Des titres identiques empêchent de distinguer clairement le sujet "
                "et l'intention de chaque URL."
                if duplicates else ""
            ),
            recommended_steps=(
                [
                    "Associer une intention principale différente à chaque URL.",
                    "Réécrire les titres en fonction du contenu propre à chaque page.",
                    "Fusionner ou canonicaliser les pages réellement équivalentes.",
                ]
                if duplicates else []
            ),
        )
    )

    has_local_context = bool(
        (city and city.strip()) or (country and country.strip())
    )
    has_address = bool(
        site_audit_result.get("business_address")
        or (
            site_audit_result.get("business_latitude") is not None
            and site_audit_result.get("business_longitude") is not None
        )
    )
    if not has_local_context:
        findings.append(
            _finding(
                rule_code="local.business_address",
                title="Vérifier l'adresse de l'entreprise",
                category="local",
                status="not_tested",
                severity="info",
                impact_score=0,
                effort_score=0,
                confidence_score=0.0,
                affected_urls=[],
                evidence=[],
                source_data=(
                    "Contrôle non exécuté : aucune ville ou aucun pays cible "
                    "n'est configuré pour l'entreprise."
                ),
                why_it_matters="",
                recommended_steps=[],
            )
        )
    else:
        findings.append(
            _finding(
                rule_code="local.business_address",
                title="Ajouter une adresse d'entreprise détectable",
                category="local",
                status="failed" if not has_address else "passed",
                severity="high" if not has_address else "info",
                impact_score=7 if not has_address else 0,
                effort_score=2 if not has_address else 0,
                confidence_score=0.9,
                affected_urls=(
                    [_page_url(page) for page in pages] if not has_address else []
                ),
                evidence=(
                    [
                        {
                            "url": str(site_audit_result.get("base_url") or "Site"),
                            "observed": (
                                "Aucune adresse ni coordonnée détectée sur les pages crawlées"
                            ),
                            "expected": (
                                "Adresse cohérente avec la zone locale configurée"
                            ),
                        }
                    ]
                    if not has_address else []
                ),
                source_data=(
                    "Aucune adresse détectée alors qu'un contexte local est configuré."
                    if not has_address
                    else "Une adresse ou des coordonnées ont été détectées."
                ),
                why_it_matters=(
                    "Une adresse cohérente renforce la compréhension de la zone "
                    "desservie et la confiance dans l'entité locale."
                    if not has_address else ""
                ),
                recommended_steps=(
                    [
                        "Afficher l'adresse réelle dans une zone de contact visible.",
                        "Ajouter la même adresse dans un schema LocalBusiness adapté.",
                        "Vérifier la cohérence avec la fiche Google Business Profile.",
                    ]
                    if not has_address else []
                ),
            )
        )

    findings.append(
        evaluate_performance(
            psi_result,
            str(site_audit_result.get("base_url") or ""),
        )
    )

    return sorted(
        findings,
        key=lambda finding: (
            finding["status"] in {"failed", "warning"},
            finding["priority_score"],
            finding["confidence_score"],
        ),
        reverse=True,
    )


def findings_to_opportunities(
    findings: list[dict[str, Any]],
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Turn verified issues into actionable opportunities without fake gains."""
    opportunities: list[dict[str, Any]] = []
    for finding in findings:
        if finding.get("status") not in {"failed", "warning"}:
            continue
        opportunities.append(
            {
                "title": finding["title"],
                "description": finding["why_it_matters"],
                "category": finding["category"],
                "impact_score": finding["impact_score"],
                "effort_score": finding["effort_score"],
                "confidence_score": finding["confidence_score"],
                "source_data": finding["source_data"],
                "rule_code": finding["rule_code"],
                "severity": finding["severity"],
                "audit_status": finding["status"],
                "priority_score": finding["priority_score"],
                "affected_urls": finding["affected_urls"],
                "evidence": finding["evidence"],
                "why_it_matters": finding["why_it_matters"],
                "recommended_steps": finding["recommended_steps"],
            }
        )
    opportunities.sort(
        key=lambda opportunity: (
            opportunity["priority_score"],
            opportunity["confidence_score"],
        ),
        reverse=True,
    )
    return opportunities[:limit]
