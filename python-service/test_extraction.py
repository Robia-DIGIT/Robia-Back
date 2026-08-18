from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright
from app.agents.ingestion import _extract_business_location, _extract_social_links

def test_playwright_reel():
    url_a_tester = "https://www.carlton-madagascar.com/contact"
    
    print("=" * 50)
    print(f"🚀 Lancement de Playwright sur : {url_a_tester}")
    print("=" * 50)
    
    with sync_playwright() as p:
        # Lancement du navigateur en arrière-plan (headless=True)
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        try:
            # Navigation et attente que le réseau soit calme
            page.goto(url_a_tester, timeout=30000, wait_until="networkidle")
            
            # Récupération de tout le code HTML rendu par le JavaScript
            html_content = page.content()
            print(f"✅ Page chargée ! ({len(html_content)} caractères récupérés)")
            
        except Exception as e:
            print(f"❌ Erreur lors de la navigation : {e}")
            browser.close()
            return
            
        browser.close()
    
    # On passe le HTML récupéré par Playwright à votre BeautifulSoup et votre extracteur
    soup = BeautifulSoup(html_content, "html.parser")
    
    print("\n🔍 Analyse des données géographiques...")
    address, lat, lng = _extract_business_location(soup)
    socials = _extract_social_links(soup)
    
    print("-" * 50)
    print("📍 RÉSULTATS DE L'EXTRACTION :")
    print(f"🏢 Adresse   : {address}")
    print(f"🌍 Latitude  : {lat}")
    print(f"🌍 Longitude : {lng}")
    print(f"📱 Réseaux   : {socials}")
    print("=" * 50)

if __name__ == "__main__":
    test_playwright_reel()