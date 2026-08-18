from playwright.sync_api import sync_playwright

url = "https://www.carlton-madagascar.com/contact"

with sync_playwright() as p:
    print("Lancement du navigateur...")
    browser = p.chromium.launch()
    print("Navigateur lancé avec succès")
    page = browser.new_page()
    print(f"Navigation vers {url}...")
    page.goto(url, timeout=15000, wait_until="networkidle")
    print("Page chargée")
    html = page.content()
    print(f"Longueur du HTML récupéré : {len(html)} caractères")
    print(html[:500])
    browser.close()