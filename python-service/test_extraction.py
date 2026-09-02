from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright
from app.agents.ingestion import _parse_soup

def test_playwright_reel():
    url_a_tester = "https://www.carlton-madagascar.com/contact"
    
    print("=" * 50)
    print(f" Lancement de Playwright sur : {url_a_tester}")
    print("=" * 50)
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        try:
            page.goto(url_a_tester, timeout=30000, wait_until="networkidle")
            html_content = page.content()
            print(f" Page chargée ! ({len(html_content)} caractères récupérés)")
        except Exception as e:
            print(f" Erreur lors de la navigation : {e}")
            browser.close()
            return
            
        browser.close()
    
    soup = BeautifulSoup(html_content, "html.parser")
    
    print("\n Analyse complète de la page...")
    parsed = _parse_soup(soup, url_a_tester)
    
    print("-" * 50)
    print(" RÉSULTATS DE L'EXTRACTION :")
    print(f" Adresse       : {parsed['business_address']}")
    print(f" Latitude      : {parsed['business_latitude']}")
    print(f" Longitude     : {parsed['business_longitude']}")
    print(f" Réseaux       : {parsed['social_links']}")
    print(f" Mots-clés     : {parsed['top_keywords']}")
    print("=" * 50)

if __name__ == "__main__":
    test_playwright_reel()

from app.agents.ingestion import crawl_website


def test_crawl():
    url_a_tester = "https://www.carlton-madagascar.com"

    print("=" * 50)
    print(f"🕸️  Lancement du crawl sur : {url_a_tester}")
    print("=" * 50)

    # Premier test volontairement limité pour valider rapidement le mécanisme
    site = crawl_website(url_a_tester, max_pages=8, max_depth=1)

    print("-" * 50)
    print(f" Méthode de découverte : {site.discovery_method}")
    print(f" URLs découvertes      : {len(site.discovered_urls)}")
    print(f" Pages analysées OK    : {len(site.pages)}")
    print(f" Pages échouées        : {len(site.failed_urls)}")
    print(f" Pages exclues         : {len(site.excluded_urls)}")
    print("-" * 50)

    if site.failed_urls:
        print("\n URLs en échec :")
        for failed in site.failed_urls:
            print(f"  - {failed}")

    print("\n Détail des pages analysées :")
    for page in site.pages:
        url_affichee = page.requested_url or page.final_url or "URL inconnue"
        h1_affiche = page.h1[0] if page.h1 else "(aucun H1)"
        print(f"  - {url_affichee}")
        print(f"      H1: {h1_affiche} | mots: {page.word_count} | JS utilisé: {page.js_rendering_used}")

    print("\n Toutes les URLs découvertes (debug doublons) :")
    for u in site.discovered_urls:
        print(f"  - {u}")

    from app.agents.ingestion import aggregate_site

    analysis = aggregate_site(site)

    print("\n SITE ANALYSIS")
    print(f"Pages analysées      : {analysis.pages_count}")
    print(f"Pages avec H1        : {analysis.pages_with_h1} / {analysis.pages_count}")
    print(f"Pages avec meta desc : {analysis.pages_with_meta_description} / {analysis.pages_count}")
    print(f"Pages avec schema.org: {analysis.pages_with_schema} / {analysis.pages_count}")
    print(f"Pages avec Open Graph: {analysis.pages_with_og} / {analysis.pages_count}")
    print(f"Mots/page en moyenne : {analysis.avg_word_count}")
    print(f"Adresse business     : {analysis.business_address}")
    print(f"Réseaux sociaux      : {analysis.social_links}")
    print(f"Mots-clés du site    : {analysis.top_keywords}")
    print("\n Findings :")
    for f in analysis.findings:
        print(f"  - {f}")

if __name__ == "__main__":
    test_crawl()