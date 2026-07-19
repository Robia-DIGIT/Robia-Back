import requests
from bs4 import BeautifulSoup
from dataclasses import dataclass


@dataclass
class ScrapedPage:
    accessible: bool
    status_code: int | None
    title: str | None
    meta_description: str | None
    main_content: str | None
    error: str | None = None


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
        return ScrapedPage(
            accessible=False,
            status_code=None,
            title=None,
            meta_description=None,
            main_content=None,
            error=str(e),
        )

    if response.status_code >= 400:
        return ScrapedPage(
            accessible=False,
            status_code=response.status_code,
            title=None,
            meta_description=None,
            main_content=None,
            error=f"HTTP {response.status_code}",
        )

    soup = BeautifulSoup(response.text, "html.parser")

    title = soup.title.string.strip() if soup.title and soup.title.string else None

    meta_tag = soup.find("meta", attrs={"name": "description"})
    meta_description = None
    if meta_tag:
        content = meta_tag.get("content")
        if isinstance(content, str):
            meta_description = content.strip()

    # Contenu principal : on prend le texte visible, tronqué pour rester léger
    for tag in soup(["script", "style", "nav", "footer"]):
        tag.decompose()
    main_content = soup.get_text(separator=" ", strip=True)[:2000] or None

    return ScrapedPage(
        accessible=True,
        status_code=response.status_code,
        title=title,
        meta_description=meta_description,
        main_content=main_content,
    )