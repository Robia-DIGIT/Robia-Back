SOCIAL_POST_SYSTEM_PROMPT = """Tu es un rédacteur de contenu pour les réseaux sociaux (Facebook/Instagram) \
de petites et moyennes entreprises locales à Madagascar. Tu écris en français, dans un ton chaleureux et \
adapté au secteur d'activité de l'entreprise. Tes posts sont courts (2 à 4 phrases maximum), concrets, \
jamais génériques, et intègrent naturellement le contexte donné (météo, horaires, activité) sans que ça \
sonne artificiel ou forcé. Tu n'utilises pas de hashtags excessifs (2 maximum) ni d'emojis en excès \
(2-3 maximum, placés avec parcimonie)."""


def build_social_post_user_prompt(
    business_name: str,
    sector: str | None,
    city: str | None,
    weather_description: str,
    temperature_c: float,
    opening_hours_today: str | None,
    top_keywords: list[str],
) -> str:
    """
    Construit le prompt utilisateur pour générer 3 variantes de post,
    une par angle fixe (direct / convivial / opportunité), à partir du
    contexte météo, horaires et thématiques dominantes du site.
    """
    context_lines = [f"Entreprise : {business_name}"]
    if sector:
        context_lines.append(f"Secteur : {sector}")
    if city:
        context_lines.append(f"Ville : {city}")

    context_lines.append(f"Météo actuelle : {weather_description}, {temperature_c:.0f}°C")
    context_lines.append(f"Horaires aujourd'hui : {opening_hours_today or 'non renseignés'}")

    if top_keywords:
        context_lines.append(f"Thématiques dominantes du site : {', '.join(top_keywords[:5])}")
    else:
        context_lines.append("Thématiques dominantes du site : non renseignées")

    context_block = "\n".join(context_lines)

    return f"""{context_block}

Rédige exactement 3 propositions de post pour les réseaux sociaux, une par angle, dans cet ordre précis :
1. Angle direct : met en avant un produit/service concret lié aux thématiques ci-dessus, sans détour.
2. Angle convivial : ton chaleureux, invite les gens à passer, s'appuie sur l'ambiance du moment (météo, horaires).
3. Angle opportunité : crée un sentiment d'à-propos ("aujourd'hui", "en ce moment") lié au contexte actuel.

Règle stricte : ne décris QUE la météo telle que donnée ci-dessus ("{weather_description}"). N'invente \
jamais de pluie, de soleil ou d'autre condition non explicitement mentionnée dans le contexte. Si la \
météo est neutre (ex: "Couvert" sans précipitation), reste sobre dessus plutôt que de dramatiser ou d'inventer.

Réponds EXACTEMENT dans ce format, avec ces marqueurs tels quels (rien avant, rien après, aucun texte \
d'introduction ni de conclusion) :

[ANGLE_DIRECT]
(texte du post ici)

[ANGLE_CONVIVIAL]
(texte du post ici)

[ANGLE_OPPORTUNITE]
(texte du post ici)"""