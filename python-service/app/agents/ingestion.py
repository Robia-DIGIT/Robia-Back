import requests
from bs4 import BeautifulSoup
from bs4.element import Tag
from dataclasses import dataclass
from urllib.parse import urlparse


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


def scrape_website(url: str) -> ScrapedPage:
    """
    Récupère une page web et en extrait les informations basiques.
    Ne lève jamais d'exception : retourne toujours un ScrapedPage,
    avec accessible=False et error rempli en cas de problème.
    """
    try:
        response = requests.get(
            url,
            timeout=10,
            headers={"User-Agent": "RobiaAuditBot/1.0"},
        )
    except requests.RequestException as e:
        return _empty_page(None, str(e))

    if response.status_code >= 400:
        return _empty_page(response.status_code, f"HTTP {response.status_code}")

    soup = BeautifulSoup(response.text, "html.parser")

    # Titre : get_text() gère aussi le cas de sous-balises dans <title>
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

    # Comptage des liens internes / externes, basé sur le domaine réel
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

    # Contenu principal : texte visible complet, utilisé pour le comptage de mots
    for tag in soup(["script", "style", "nav", "footer"]):
        tag.decompose()
    full_text = soup.get_text(separator=" ", strip=True)
    word_count = len(full_text.split()) if full_text else 0
    main_content = full_text[:2000] or None

    return ScrapedPage(
        accessible=True,
        status_code=response.status_code,
        title=title,
        meta_description=meta_description,
        h1=h1,
        h2=h2,
        h3=h3,
        canonical=canonical,
        meta_robots=meta_robots,
        images_count=images_count,
        images_without_alt=images_without_alt,
        internal_links_count=internal_links_count,
        external_links_count=external_links_count,
        word_count=word_count,
        main_content=main_content,
    )