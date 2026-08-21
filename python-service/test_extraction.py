from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright
from app.agents.ingestion import _parse_soup

def test_playwright_reel():
    url_a_tester = "https://www.carlton-madagascar.com/contact"
    
    print("=" * 50)
    print(f"🚀 Lancement de Playwright sur : {url_a_tester}")
    print("=" * 50)
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        try:
            page.goto(url_a_tester, timeout=30000, wait_until="networkidle")
            html_content = page.content()
            print(f"✅ Page chargée ! ({len(html_content)} caractères récupérés)")
        except Exception as e:
            print(f"❌ Erreur lors de la navigation : {e}")
            browser.close()
            return
            
        browser.close()
    
    soup = BeautifulSoup(html_content, "html.parser")
    
    print("\n🔍 Analyse complète de la page...")
    parsed = _parse_soup(soup, url_a_tester)
    
    print("-" * 50)
    print("📍 RÉSULTATS DE L'EXTRACTION :")
    print(f"🏢 Adresse       : {parsed['business_address']}")
    print(f"🌍 Latitude      : {parsed['business_latitude']}")
    print(f"🌍 Longitude     : {parsed['business_longitude']}")
    print(f"📱 Réseaux       : {parsed['social_links']}")
    print(f"🔑 Mots-clés     : {parsed['top_keywords']}")
    print("=" * 50)

if __name__ == "__main__":
    test_playwright_reel()