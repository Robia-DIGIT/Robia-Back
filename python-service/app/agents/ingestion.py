import json
import requests
import re
import os
from bs4 import BeautifulSoup
from bs4.element import Tag
from dataclasses import dataclass, field
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
from collections import Counter
from collections import deque
from urllib.parse import urljoin
import xml.etree.ElementTree as ET


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

    social_links: dict = field(default_factory=dict)

    js_rendering_suspected: bool = False
    js_rendering_used: bool = False

    top_keywords: list[str] = field(default_factory=list)
    requested_url: str | None = None  

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
        social_links={},
        js_rendering_suspected=False,
        js_rendering_used=False,
        top_keywords=[],
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

def _extract_social_links(soup: BeautifulSoup) -> dict:
    """
    Scanne tous les liens de la page pour détecter les réseaux sociaux.
    Retourne un dictionnaire ex: {'facebook': 'url', 'whatsapp': 'url'}
    """
    social_links = {}
    networks = {
        "facebook": ["facebook.com", "fb.com"],
        "instagram": ["instagram.com"],
        "twitter": ["twitter.com", "x.com"],
        "linkedin": ["linkedin.com"],
        "whatsapp": ["wa.me", "api.whatsapp.com", "whatsapp.com/send"],
        "youtube": ["youtube.com", "youtu.be"],
        "tiktok": ["tiktok.com"]
    }

    for a in soup.find_all("a", href=True):
        href = _attr_to_str(a.get("href"))
        if not href:
            continue
        
        href_lower = href.lower()
        for network, domains in networks.items():
            if network not in social_links:
                if any(domain in href_lower for domain in domains):
                    social_links[network] = href.strip()
                    
    return social_links

_STOPWORDS = {
    # Français
    "le", "la", "les", "de", "des", "du", "un", "une", "et", "à", "en",
    "pour", "avec", "sur", "dans", "est", "sont", "vous", "nous", "notre",
    "votre", "nos", "vos", "ce", "ces", "cette", "que", "qui", "au", "aux",
    "par", "plus", "ne", "pas", "être", "avoir", "tout", "tous", "toute",
    "toutes", "il", "elle", "ils", "elles", "leur", "leurs", "son", "sa",
    "ses", "vers", "chez", "sans", "sous", "entre", "comme", "ainsi",
    # Anglais (utile pour les sites bilingues comme carlton-madagascar.com)
    "the", "and", "for", "with", "you", "your", "our", "are", "this",
    "that", "from", "have", "has", "will", "can", "all", "not", "but",
    "was", "were", "been", "being", "into", "than", "then", "them", "their",
}


def _extract_top_keywords(text: str, top_n: int = 10) -> list[str]:
    """
    Extrait les termes les plus fréquents du contenu textuel de la page,
    après filtrage des mots vides (stopwords FR/EN) et des mots trop courts.
    Purement déterministe (comptage de fréquence), aucune dépendance externe.
    """
    if not text:
        return []

    words = re.findall(r"[a-zà-öø-ÿ]+", text.lower())
    filtered = [w for w in words if len(w) > 3 and w not in _STOPWORDS]

    if not filtered:
        return []

    counts = Counter(filtered)
    return [word for word, _ in counts.most_common(top_n)]

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

    social_links = _extract_social_links(soup)

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
    top_keywords = _extract_top_keywords(full_text, top_n=10)

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
        "social_links": social_links,
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
        "top_keywords": top_keywords,
    }


def _fetch_rendered_html(url: str, timeout_ms: int = 15000, browser=None) -> str | None:
    """
    Récupère le HTML après exécution du JavaScript, via un navigateur headless
    (Playwright/Chromium). Utilisé en fallback quand le scraping statique
    laisse suspecter une SPA (React/Next.js/Vue).

    Si un `browser` (déjà lancé) est fourni, réutilise cette instance —
    évite de relancer un navigateur complet à chaque appel lors d'un crawl
    multi-pages (coût dominant de la lenteur observée en pratique).
    Sinon (usage autonome, ex: scrape_website() appelée seule), ouvre et
    ferme son propre navigateur comme avant.

    Ne lève jamais d'exception : retourne None en cas d'échec.
    """
    if os.getenv("DISABLE_JS_RENDERING", "false").lower() == "true":
        print(f"Playwright désactivé via variable d'environnement pour {url}")
        return None

    user_agent = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

    if browser is not None:
        page = None
        try:
            page = browser.new_page(user_agent=user_agent)
            page.goto(url, timeout=30000, wait_until="load")
            page.wait_for_timeout(3000)
            return page.content()
        except Exception as e:
            print(f"Erreur lors du rendu JavaScript pour {url}: {e}")
            return None
        finally:
            if page is not None:
                page.close()

    try:
        with sync_playwright() as p:
            local_browser = p.chromium.launch()
            page = local_browser.new_page(user_agent=user_agent)
            page.goto(url, timeout=30000, wait_until="load")
            page.wait_for_timeout(3000)
            html = page.content()
            local_browser.close()
            return html
    except Exception as e:
        print(f"Erreur lors du rendu JavaScript pour {url}: {e}")
        return None


def scrape_website(url: str, browser=None) -> ScrapedPage:
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

    js_rendering_suspected = parsed["word_count"] < 150 or not parsed["h1"]
    js_rendering_used = False

    if js_rendering_suspected:
        rendered_html = _fetch_rendered_html(url, browser=browser)
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
        social_links=parsed.get("social_links", {}),
        top_keywords=parsed.get("top_keywords", []),
        js_rendering_suspected=js_rendering_suspected,
        js_rendering_used=js_rendering_used,
    )

@dataclass
class ScrapedSite:
    """
    Représente le résultat du crawl d'un site entier : plusieurs ScrapedPage,
    plus le suivi de ce qui a été découvert / échoué, pour le reporting.
    """
    base_url: str
    pages: list[ScrapedPage] = field(default_factory=list)
    discovered_urls: list[str] = field(default_factory=list)
    failed_urls: list[str] = field(default_factory=list)
    excluded_urls: list[str] = field(default_factory=list)
    discovery_method: str = "unknown"  # "sitemap" ou "links"


def _normalize_base_url(url: str) -> str:
    """Réduit une URL quelconque (ex: .../contact) à son origine (scheme://host)."""
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


def _normalize_url(url: str, base_netloc: str) -> str | None:
    """
    Nettoise une URL découverte (sitemap ou lien <a>) :
    - rejette les URLs hors domaine
    - retire le fragment (#...) et le query string (?lang=fr, ?utm_source=...)
      car ils ne créent généralement pas de contenu réellement distinct et
      cassent sinon la déduplication (vu en pratique sur Carlton : /chambres
      et /chambres?lang=fr sont la même page)
    - retire les slashs finaux
    Retourne None si l'URL n'est pas exploitable ou hors domaine.
    """
    parsed = urlparse(url)
    netloc = parsed.netloc or base_netloc
    if netloc != base_netloc:
        return None
    if not parsed.scheme:
        return None
    path = parsed.path or "/"
    clean = f"{parsed.scheme}://{netloc}{path}"
    return clean.rstrip("/") or f"{parsed.scheme}://{netloc}"

_EXCLUDED_EXTENSIONS = (
    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico",
    ".zip", ".rar", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".mp4", ".mp3", ".avi", ".css", ".js", ".xml", ".json",
)

_EXCLUDED_PATH_KEYWORDS = (
    "politique-confidentialite", "privacy", "mentions-legales",
    "cgv", "cgu", "conditions-generales", "terms", "cookie",
    "plan-du-site", "sitemap", "login", "connexion", "compte",
    "panier", "cart", "checkout",
)


def _is_legal_or_utility_page(url: str) -> bool:
    """Filtre les pages légales/utilitaires sans intérêt pour un audit SEO/business."""
    path = urlparse(url).path.lower()
    return any(keyword in path for keyword in _EXCLUDED_PATH_KEYWORDS)

def _should_exclude(url: str) -> bool:
    """Filtre les URLs non pertinentes : extensions non-HTML ou pages légales/utilitaires."""
    lower_url = url.lower().split("?")[0]
    if lower_url.endswith(_EXCLUDED_EXTENSIONS):
        return True
    return _is_legal_or_utility_page(url)

def _discover_from_sitemap(base_url: str) -> list[str]:
    """
    Tente de récupérer la liste d'URLs via /sitemap.xml.
    Gère le cas d'un sitemap index (liste de sous-sitemaps) sur UN seul niveau
    de profondeur, suffisant pour la V1. Retourne [] si absent/invalide.
    """
    sitemap_url = f"{base_url}/sitemap.xml"
    try:
        response = requests.get(
            sitemap_url,
            timeout=10,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
        )
        if response.status_code != 200 or not response.content:
            return []

        root = ET.fromstring(response.content)
        ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

        locs = [loc.text.strip() for loc in root.findall(".//sm:loc", ns) if loc.text]
        if not locs:
            locs = [loc.text.strip() for loc in root.findall(".//loc") if loc.text]
        if not locs:
            return []

        # Cas sitemap index : les <loc> pointent vers d'autres sitemap.xml
        if all(loc.lower().endswith(".xml") for loc in locs):
            all_urls: list[str] = []
            for sub_sitemap in locs[:5]:  # limite de sécurité : 5 sous-sitemaps max
                try:
                    sub_resp = requests.get(sub_sitemap, timeout=10)
                    if sub_resp.status_code != 200:
                        continue
                    sub_root = ET.fromstring(sub_resp.content)
                    sub_locs = [loc.text.strip() for loc in sub_root.findall(".//sm:loc", ns) if loc.text]
                    all_urls.extend(sub_locs)
                except (requests.RequestException, ET.ParseError):
                    continue
            return all_urls

        return locs

    except (requests.RequestException, ET.ParseError):
        return []


def _discover_from_links(soup: BeautifulSoup, current_url: str, base_netloc: str) -> list[str]:
    """
    Extrait et normalise les liens internes d'une page déjà parsée (fallback BFS).
    Ne filtre PAS les URLs à exclure ici — laisse crawl_website() décider et
    comptabiliser correctement les exclusions dans site.excluded_urls, pour
    que le compteur soit fiable aussi bien en mode sitemap qu'en mode fallback.
    """
    found = []
    for a in soup.find_all("a", href=True):
        href = _attr_to_str(a.get("href"))
        if not href:
            continue
        href = href.strip()
        if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        absolute = urljoin(current_url, href)
        normalized = _normalize_url(absolute, base_netloc)
        if normalized:
            found.append(normalized)
    return found

def _fetch_soup_for_discovery(url: str, browser=None) -> BeautifulSoup | None:
    """
    Récupère le soup d'une page pour en extraire les liens de navigation.
    Bascule sur Playwright si le HTML statique semble trop pauvre en liens
    (site SPA où la nav est injectée en JS) — même logique d'escalade que
    scrape_website() pour le contenu, appliquée ici aux liens.
    """
    try:
        response = requests.get(
            url,
            timeout=10,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
        )
    except requests.RequestException:
        return None

    if response.status_code >= 400:
        return None

    soup = BeautifulSoup(response.text, "html.parser")
    link_count = len(soup.find_all("a", href=True))

    if link_count < 3:
        rendered_html = _fetch_rendered_html(url, browser=browser)
        if rendered_html:
            rendered_soup = BeautifulSoup(rendered_html, "html.parser")
            if len(rendered_soup.find_all("a", href=True)) > link_count:
                return rendered_soup

    return soup


def crawl_website(url: str, max_pages: int = 30, max_depth: int = 2) -> ScrapedSite:
    """
    Découvre et scrape plusieurs pages d'un même site, en réutilisant
    scrape_website() pour chaque page individuelle (aucune logique
    d'extraction dupliquée).

    Stratégie :
    1. /sitemap.xml — si présent, c'est la source la plus fiable et exhaustive.
    2. Fallback : BFS sur les liens internes découverts à partir de l'URL de
       départ, jusqu'à max_depth ou max_pages. Pour les sites SPA (JS), la
       découverte de liens bascule aussi sur Playwright si nécessaire.

    Un seul navigateur Playwright est ouvert pour tout le crawl (au lieu
    d'un par page) — optimisation qui réduit fortement le temps total sur
    les sites SPA où Playwright se déclenche sur chaque page. Ignoré si
    DISABLE_JS_RENDERING=true (aucun navigateur n'est même lancé dans ce cas).

    Ne lève jamais d'exception : les pages en échec vont dans failed_urls.
    """
    base_url = _normalize_base_url(url)
    base_netloc = urlparse(base_url).netloc

    site = ScrapedSite(base_url=base_url)
    visited: set[str] = set()

    sitemap_urls = _discover_from_sitemap(base_url)

    js_rendering_disabled = os.getenv("DISABLE_JS_RENDERING", "false").lower() == "true"
    playwright_ctx = None
    browser = None

    if not js_rendering_disabled:
        try:
            playwright_ctx = sync_playwright().start()
            browser = playwright_ctx.chromium.launch()
        except Exception as e:
            print(f"Impossible de lancer Playwright pour le crawl : {e}")
            if playwright_ctx is not None:
                playwright_ctx.stop()
            playwright_ctx = None
            browser = None

    try:
        if sitemap_urls:
            site.discovery_method = "sitemap"
            candidates: list[str] = []
            for raw_url in sitemap_urls:
                normalized = _normalize_url(raw_url, base_netloc)
                if not normalized:
                    continue
                if _should_exclude(normalized):
                    site.excluded_urls.append(normalized)
                    continue
                if normalized not in candidates:
                    candidates.append(normalized)

            candidates = candidates[:max_pages]

            for page_url in candidates:
                if page_url in visited:
                    continue
                visited.add(page_url)
                site.discovered_urls.append(page_url)

                scraped = scrape_website(page_url, browser=browser)
                if scraped.accessible:
                    scraped.requested_url = page_url
                    site.pages.append(scraped)
                else:
                    site.failed_urls.append(page_url)

            return site

        # --- Fallback : BFS sur les liens internes ---
        site.discovery_method = "links"
        start_url = _normalize_url(url, base_netloc) or base_url
        queue: deque[tuple[str, int]] = deque([(start_url, 0)])
        visited.add(start_url)

        while queue and (len(site.pages) + len(site.failed_urls)) < max_pages:
            current_url, depth = queue.popleft()
            site.discovered_urls.append(current_url)

            scraped = scrape_website(current_url, browser=browser)
            if not scraped.accessible:
                site.failed_urls.append(current_url)
                continue

            scraped.requested_url = current_url
            site.pages.append(scraped)

            if depth >= max_depth:
                continue

            soup = _fetch_soup_for_discovery(current_url, browser=browser)
            if soup is None:
                continue

            for link in _discover_from_links(soup, current_url, base_netloc):
                if link in visited:
                    continue
                if _should_exclude(link):
                    if link not in site.excluded_urls:
                        site.excluded_urls.append(link)
                    visited.add(link)
                    continue
                if len(visited) < max_pages * 3:
                    visited.add(link)
                    queue.append((link, depth + 1))

        return site

    finally:
        if browser is not None:
            browser.close()
        if playwright_ctx is not None:
            playwright_ctx.stop()


@dataclass
class SiteAnalysis:
    """
    Vue agrégée d'un site entier, calculée à partir d'un ScrapedSite.
    Signaux purement déterministes — le scoring/ai_readiness reste dans analysis.py.
    """
    base_url: str
    pages_count: int

    pages_with_h1: int
    pages_without_h1: int
    pages_with_meta_description: int
    pages_without_meta_description: int
    pages_with_schema: int
    pages_without_schema: int
    pages_with_og: int
    pages_without_og: int

    avg_word_count: float

    business_address: str | None
    business_latitude: float | None
    business_longitude: float | None
    location_precision: str    

    social_links: dict
    top_keywords: list[str]

    findings: list[str]
    page_summaries: list[dict]


def aggregate_site(site: ScrapedSite, city: str | None = None, country: str | None = None) -> SiteAnalysis:
    """
    Transforme un ScrapedSite (liste de ScrapedPage) en SiteAnalysis :
    compteurs globaux, mots-clés dominants du site (recalculés sur le
    contenu agrégé, pas une simple union des top_keywords par page, pour
    une vraie fréquence au niveau site), premières infos business trouvées,
    réseaux sociaux fusionnés, et une liste de findings prêts à consommer
    par analysis.py (strengths/missing_data).
    """
    pages = site.pages
    pages_count = len(pages)

    if pages_count == 0:
        return SiteAnalysis(
            base_url=site.base_url,
            pages_count=0,
            pages_with_h1=0, pages_without_h1=0,
            pages_with_meta_description=0, pages_without_meta_description=0,
            pages_with_schema=0, pages_without_schema=0,
            pages_with_og=0, pages_without_og=0,
            avg_word_count=0.0,
            business_address=None, business_latitude=None, business_longitude=None,
            location_precision="none",
            social_links={}, top_keywords=[],
            findings=["Aucune page n'a pu être analysée sur ce site."],
            page_summaries=[],
        )

    pages_with_h1 = sum(1 for p in pages if p.h1)
    pages_with_meta = sum(1 for p in pages if p.meta_description)
    pages_with_schema = sum(1 for p in pages if p.structured_data_types)
    pages_with_og = sum(1 for p in pages if p.og_tags_present)

    total_words = sum(p.word_count for p in pages)
    avg_word_count = round(total_words / pages_count, 1)

    business_address = business_latitude = business_longitude = None
    for p in pages:
        if p.business_address and not business_address:
            business_address = p.business_address
        if p.business_latitude is not None and business_latitude is None:
            business_latitude = p.business_latitude
            business_longitude = p.business_longitude
        if business_address and business_latitude is not None:
            break

    # Fallback géocodage : adresse texte trouvée mais aucune coordonnée
    # (ex: via un lien "itinéraire", sans JSON-LD geo ni iframe Maps)
    location_precision = "exact" if business_latitude is not None else "none"
    if business_address and business_latitude is None:
        geocoded_lat, geocoded_lng, location_precision = _geocode_address(
            business_address, city=city, country=country
        )
        if geocoded_lat is not None:
            business_latitude, business_longitude = geocoded_lat, geocoded_lng

    social_links: dict = {}
    for p in pages:
        for network, link in p.social_links.items():
            social_links.setdefault(network, link)

    # Mots-clés dominants recalculés sur le contenu agrégé du site entier,
    # pas une simple union des top_keywords par page (qui perdrait la fréquence réelle)
    combined_text = " ".join(p.main_content for p in pages if p.main_content)
    top_keywords = _extract_top_keywords(combined_text, top_n=15)

    findings: list[str] = []
    if pages_without_h1 := (pages_count - pages_with_h1):
        findings.append(f"{pages_without_h1} page(s) sur {pages_count} sans balise H1.")
    if pages_without_meta := (pages_count - pages_with_meta):
        findings.append(f"{pages_without_meta} page(s) sur {pages_count} sans meta description.")
    if pages_without_schema := (pages_count - pages_with_schema):
        findings.append(f"{pages_without_schema} page(s) sur {pages_count} sans données structurées (schema.org).")
    if pages_without_og := (pages_count - pages_with_og):
        findings.append(f"{pages_without_og} page(s) sur {pages_count} sans balises Open Graph.")
    if not social_links:
        findings.append("Aucun réseau social détecté sur l'ensemble du site.")
    if not business_address:
        findings.append("Aucune adresse d'entreprise détectée sur le site.")
    if top_keywords:
        findings.append(f"Termes dominants du site : {', '.join(top_keywords[:5])}.")

    page_summaries = [
        {
            "url": p.requested_url or p.final_url,
            "title": p.title,
            "h1": p.h1[0] if p.h1 else None,
            "word_count": p.word_count,
            "has_meta_description": bool(p.meta_description),
            "has_schema": bool(p.structured_data_types),
        }
        for p in pages
    ]

    return SiteAnalysis(
        base_url=site.base_url,
        pages_count=pages_count,
        pages_with_h1=pages_with_h1,
        pages_without_h1=pages_count - pages_with_h1,
        pages_with_meta_description=pages_with_meta,
        pages_without_meta_description=pages_count - pages_with_meta,
        pages_with_schema=pages_with_schema,
        pages_without_schema=pages_count - pages_with_schema,
        pages_with_og=pages_with_og,
        pages_without_og=pages_count - pages_with_og,
        avg_word_count=avg_word_count,
        business_address=business_address,
        business_latitude=business_latitude,
        business_longitude=business_longitude,
        location_precision=location_precision,
        social_links=social_links,
        top_keywords=top_keywords,
        findings=findings,
        page_summaries=page_summaries,
    )

def _map_google_precision(location_type: str, partial_match: bool) -> str:
    """Traduit le niveau de précision Google Geocoding vers nos 3 tiers internes."""
    if location_type in ("ROOFTOP", "RANGE_INTERPOLATED"):
        return "exact"
    if location_type == "GEOMETRIC_CENTER":
        return "street"
    return "approximate"  # APPROXIMATE, ou résultat de type locality/ville uniquement


def _geocode_address_google(query: str, api_key: str) -> tuple[float, float, str] | None:
    """
    Géocode via l'API Google Geocoding. Retourne (lat, lng, precision) ou None
    en cas d'échec/absence de résultat. Precision : "exact" (bâtiment précis),
    "street" (rue identifiée mais pas le numéro exact), "approximate" (ville
    uniquement, aucune correspondance de rue trouvée).
    """
    try:
        response = requests.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params={"address": query, "key": api_key},
            timeout=10,
        )
        if response.status_code != 200:
            return None
        data = response.json()
        if data.get("status") != "OK" or not data.get("results"):
            return None

        result = data["results"][0]
        geometry = result.get("geometry", {})
        location = geometry.get("location", {})
        lat, lng = location.get("lat"), location.get("lng")
        if lat is None or lng is None:
            return None

        location_type = geometry.get("location_type", "APPROXIMATE")
        partial_match = result.get("partial_match", False)
        precision = _map_google_precision(location_type, partial_match)

        return float(lat), float(lng), precision
    except (requests.RequestException, ValueError, KeyError, IndexError):
        return None


def _geocode_address(address: str, city: str | None = None, country: str | None = None) -> tuple[float | None, float | None, str]:
    """
    Géocode une adresse texte en (latitude, longitude, precision).

    Priorité à Google Geocoding si GOOGLE_MAPS_API_KEY est configurée (bien
    meilleure couverture constatée sur Madagascar : identifie au moins la rue
    là où Nominatim ne trouve parfois rien du tout). Fallback sur Nominatim
    (gratuit, sans clé) si Google échoue ou si aucune clé n'est configurée —
    garde le système fonctionnel même sans configuration Google.

    Retourne (lat, lng, precision), avec precision parmi :
    "exact" (bâtiment précis), "street" (rue identifiée), "approximate"
    (ville uniquement), "none" (rien trouvé).
    """
    google_api_key = os.getenv("GOOGLE_MAPS_API_KEY")

    if google_api_key:
        google_result = _geocode_address_google(address, google_api_key)
        if google_result:
            return google_result

    # Fallback Nominatim opensource ny openstreetmap ito (gratuit, sans clé) : adresse complète, puis ville/pays ( activé si manao échec ilay module google Geocoding)
    def _query_nominatim(q: str) -> tuple[float, float] | None:
        try:
            response = requests.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": q, "format": "json", "limit": 1},
                headers={"User-Agent": "RobiaAuditBot/1.0 (contact: hello@robia.digital)"},
                timeout=10,
            )
            if response.status_code != 200:
                return None
            results = response.json()
            if not results:
                return None
            return float(results[0]["lat"]), float(results[0]["lon"])
        except (requests.RequestException, ValueError, KeyError, IndexError):
            return None

    exact = _query_nominatim(address)
    if exact:
        return exact[0], exact[1], "exact"

    if city or country:
        fallback_query = ", ".join(part for part in [city, country] if part)
        approximate = _query_nominatim(fallback_query)
        if approximate:
            return approximate[0], approximate[1], "approximate"

    return None, None, "none"