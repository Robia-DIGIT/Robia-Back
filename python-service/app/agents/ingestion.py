import json
import requests
import re
from bs4 import BeautifulSoup
from bs4.element import Tag
from dataclasses import dataclass, field
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError


@dataclass
class ScrapedPage:
    accessible: bool
    status_code: int | None

    title: str | None
    meta_description: str | None

    h1: list[str]
    h2: list[str]
    h3: list[str]

    canonical: str | None
    meta_robots: str | None

    images_count: int
    images_without_alt: int

    internal_links_count: int
    external_links_count: int

    word_count: int

    main_content: str | None

    response_time_ms: float | None = None
    final_url: str | None = None
    redirect_count: int = 0
    viewport_present: bool = False
    structured_data_types: list[str] = field(default_factory=list)
    og_tags_present: list[str] = field(default_factory=list)
    html_lang: str | None = None

    business_address: str | None = None
    business_latitude: float | None = None
    business_longitude: float | None = None

    js_rendering_suspected: bool = False
    js_rendering_used: bool = False

    error: str | None = None


def _empty_page(status_code, error) -> ScrapedPage:
    return ScrapedPage(
        accessible=False,
        status_code=status_code,
        title=None,
        meta_description=None,
        h1=[],
        h2=[],
        h3=[],
        canonical=None,
        meta_robots=None,
        images_count=0,
        images_without_alt=0,
        internal_links_count=0,
        external_links_count=0,
        word_count=0,
        main_content=None,
        response_time_ms=None,
        final_url=None,
        redirect_count=0,
        viewport_present=False,
        structured_data_types=[],
        og_tags_present=[],
        html_lang=None,
        business_address=None,
        business_latitude=None,
        business_longitude=None,
        js_rendering_suspected=False,
        js_rendering_used=False,
        error=error,
    )


def _attr_to_str(value) -> str | None:
    """
    Normalise une valeur d'attribut BeautifulSoup (str | AttributeValueList | None)
    en str | None : certains attributs HTML (ex: class) peuvent renvoyer
    une liste de tokens plutôt qu'une simple chaîne.
    """
    if value is None:
        return None
    if isinstance(value, list):
        return " ".join(value) if value else None
    return str(value)


def _extract_structured_data_types(soup: BeautifulSoup) -> list[str]:
    """
    Extrait les types schema.org déclarés en JSON-LD (le format le plus courant
    et le plus fiable à détecter, contrairement au microdata dispersé dans le HTML).
    """
    types: list[str] = []
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            data = json.loads(script.string or "")
        except (json.JSONDecodeError, TypeError):
            continue

        entries = data if isinstance(data, list) else [data]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            graph = entry.get("@graph", [entry])
            for item in graph:
                if isinstance(item, dict) and "@type" in item:
                    item_type = item["@type"]
                    if isinstance(item_type, list):
                        types.extend(item_type)
                    else:
                        types.append(item_type)
    return list(set(types))


def _extract_og_tags(soup: BeautifulSoup) -> list[str]:
    """Retourne la liste des propriétés Open Graph présentes (og:title, og:image...)."""
    og_tags: list[str] = []
    for tag in soup.find_all("meta"):
        if isinstance(tag, Tag):
            prop = _attr_to_str(tag.get("property"))
            if prop and prop.startswith("og:"):
                og_tags.append(prop)
    return og_tags


def _extract_from_maps_directions_link(soup: BeautifulSoup) -> str | None:
    """
    Cherche un lien 'Obtenir l'itinéraire' / 'Get directions' vers Google Maps,
    très courant sur les sites d'hôtels/restaurants/commerces. L'adresse est
    directement lisible dans le paramètre 'destination' de l'URL.
    """
    for a in soup.find_all("a", href=True):
        href = _attr_to_str(a.get("href")) or ""
        if "google.com/maps/dir" in href:
            parsed = urlparse(href)
            params = parse_qs(parsed.query)
            destination = params.get("destination", [None])[0]
            if destination:
                return destination
    return None


def _extract_business_location(soup: BeautifulSoup) -> tuple[str | None, float | None, float | None]:
    """
    Tente d'extraire l'adresse et les coordonnées de l'entreprise depuis :
    1. Les données structurées schema.org (address/geo)
    2. Une iframe Google Maps intégrée
    3. Un lien "Obtenir l'itinéraire" vers Google Maps
    Retourne (address, latitude, longitude), chaque valeur pouvant être None.
    """
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            data = json.loads(script.string or "")
        except (json.JSONDecodeError, TypeError):
            continue

        entries = data if isinstance(data, list) else [data]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            graph = entry.get("@graph", [entry])
            for item in graph:
                if not isinstance(item, dict):
                    continue
                if "address" not in item and "geo" not in item:
                    continue

                address = None
                addr_data = item.get("address")
                if isinstance(addr_data, dict):
                    parts = [
                        addr_data.get("streetAddress", ""),
                        addr_data.get("addressLocality", ""),
                        addr_data.get("addressCountry", ""),
                    ]
                    address = ", ".join(p for p in parts if p) or None
                elif isinstance(addr_data, str):
                    address = addr_data

                geo = item.get("geo")
                if isinstance(geo, dict):
                    lat = geo.get("latitude")
                    lng = geo.get("longitude")
                    if lat is not None and lng is not None:
                        try:
                            return address, float(lat), float(lng)
                        except (TypeError, ValueError):
                            pass

                if address:
                    return address, None, None

    for iframe in soup.find_all("iframe", src=True):
        src = _attr_to_str(iframe.get("src")) or ""
        if "google.com/maps" in src:
            match = re.search(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", src)
            if match:
                return None, float(match.group(1)), float(match.group(2))

    directions_address = _extract_from_maps_directions_link(soup)
    if directions_address:
        return directions_address, None, None

    return None, None, None


def _parse_soup(soup: BeautifulSoup, url: str) -> dict:
    """
    Extrait l'ensemble des signaux SEO/techniques à partir d'un objet BeautifulSoup
    déjà construit. Réutilisée que le HTML vienne d'une requête statique ou d'un
    rendu Playwright, pour éviter toute duplication de la logique d'extraction.
    """
    title = soup.title.get_text(strip=True) if soup.title else None
    title = title or None

    meta_tag = soup.find("meta", attrs={"name": "description"})
    meta_description = None
    if isinstance(meta_tag, Tag):
        content = _attr_to_str(meta_tag.get("content"))
        if content:
            meta_description = content.strip()

    canonical_tag = soup.find("link", rel="canonical")
    canonical = _attr_to_str(canonical_tag.get("href")) if isinstance(canonical_tag, Tag) else None

    robots_tag = soup.find("meta", attrs={"name": "robots"})
    meta_robots = _attr_to_str(robots_tag.get("content")) if isinstance(robots_tag, Tag) else None

    viewport_tag = soup.find("meta", attrs={"name": "viewport"})
    viewport_present = isinstance(viewport_tag, Tag)

    structured_data_types = _extract_structured_data_types(soup)
    og_tags_present = _extract_og_tags(soup)
    business_address, business_latitude, business_longitude = _extract_business_location(soup)

    html_lang = None
    if soup.html and isinstance(soup.html, Tag):
        html_lang = _attr_to_str(soup.html.get("lang"))

    base_netloc = urlparse(url).netloc
    internal_links_count = 0
    external_links_count = 0
    for a in soup.find_all("a", href=True):
        href = _attr_to_str(a.get("href"))
        if not href:
            continue
        href = href.strip()
        if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        if href.startswith("/"):
            internal_links_count += 1
        elif href.startswith("http"):
            if urlparse(href).netloc == base_netloc:
                internal_links_count += 1
            else:
                external_links_count += 1
        else:
            internal_links_count += 1

    images = soup.find_all("img")
    images_count = len(images)
    images_without_alt = len([img for img in images if not img.get("alt")])

    h1 = [h.get_text(strip=True) for h in soup.find_all("h1")]
    h2 = [h.get_text(strip=True) for h in soup.find_all("h2")]
    h3 = [h.get_text(strip=True) for h in soup.find_all("h3")]

    for tag in soup(["script", "style", "nav", "footer"]):
        tag.decompose()
    full_text = soup.get_text(separator=" ", strip=True)
    word_count = len(full_text.split()) if full_text else 0
    main_content = full_text[:2000] or None

    return {
        "title": title,
        "meta_description": meta_description,
        "canonical": canonical,
        "meta_robots": meta_robots,
        "viewport_present": viewport_present,
        "structured_data_types": structured_data_types,
        "og_tags_present": og_tags_present,
        "business_address": business_address,
        "business_latitude": business_latitude,
        "business_longitude": business_longitude,
        "html_lang": html_lang,
        "internal_links_count": internal_links_count,
        "external_links_count": external_links_count,
        "images_count": images_count,
        "images_without_alt": images_without_alt,
        "h1": h1,
        "h2": h2,
        "h3": h3,
        "word_count": word_count,
        "main_content": main_content,
    }


def _fetch_rendered_html(url: str, timeout_ms: int = 15000) -> str | None:
    """
    Récupère le HTML après exécution du JavaScript, via un navigateur headless
    local (Playwright/Chromium). Utilisé uniquement en fallback, quand le
    scraping statique laisse suspecter une SPA (React/Next.js/Vue).
    Ne lève jamais d'exception : retourne None en cas d'échec.
    """
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
            page.goto(url, timeout=timeout_ms, wait_until="networkidle")
            html = page.content()
            browser.close()
            return html
    except Exception as e:
        return None


def scrape_website(url: str) -> ScrapedPage:
    """
    Récupère une page web et en extrait les informations basiques.
    Tente d'abord un scraping HTTP statique (rapide). Si le contenu détecté
    est anormalement faible par rapport à la taille du HTML brut, retente
    avec un rendu JavaScript complet (Playwright) en fallback.
    Ne lève jamais d'exception : retourne toujours un ScrapedPage,
    avec accessible=False et error rempli en cas de problème.
    """
    try:
        response = requests.get(
            url,
            timeout=10,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
            allow_redirects=True,
        )
    except requests.RequestException as e:
        return _empty_page(None, str(e))

    response_time_ms = response.elapsed.total_seconds() * 1000
    final_url = response.url if response.url != url else None
    redirect_count = len(response.history)

    if response.status_code >= 400:
        page = _empty_page(response.status_code, f"HTTP {response.status_code}")
        page.response_time_ms = response_time_ms
        page.final_url = final_url
        page.redirect_count = redirect_count
        return page

    soup = BeautifulSoup(response.text, "html.parser")
    parsed = _parse_soup(soup, url)

    js_rendering_suspected = parsed["word_count"] < 20
    js_rendering_used = False

    if js_rendering_suspected:
        rendered_html = _fetch_rendered_html(url)
        if rendered_html:
            rendered_soup = BeautifulSoup(rendered_html, "html.parser")
            rendered_parsed = _parse_soup(rendered_soup, url)
            # On ne garde le rendu Playwright que s'il a réellement trouvé plus de contenu
            if rendered_parsed["word_count"] > parsed["word_count"]:
                parsed = rendered_parsed
                js_rendering_used = True

    return ScrapedPage(
        accessible=True,
        status_code=response.status_code,
        title=parsed["title"],
        meta_description=parsed["meta_description"],
        h1=parsed["h1"],
        h2=parsed["h2"],
        h3=parsed["h3"],
        canonical=parsed["canonical"],
        meta_robots=parsed["meta_robots"],
        images_count=parsed["images_count"],
        images_without_alt=parsed["images_without_alt"],
        internal_links_count=parsed["internal_links_count"],
        external_links_count=parsed["external_links_count"],
        word_count=parsed["word_count"],
        main_content=parsed["main_content"],
        response_time_ms=response_time_ms,
        final_url=final_url,
        redirect_count=redirect_count,
        viewport_present=parsed["viewport_present"],
        structured_data_types=parsed["structured_data_types"],
        og_tags_present=parsed["og_tags_present"],
        html_lang=parsed["html_lang"],
        business_address=parsed["business_address"],
        business_latitude=parsed["business_latitude"],
        business_longitude=parsed["business_longitude"],
        js_rendering_suspected=js_rendering_suspected,
        js_rendering_used=js_rendering_used,
    )