from app.agents.ingestion import scrape_website

def test_site_reel():
    url_a_tester = "https://www.carlton-madagascar.com/contact"
    
    print("="*50)
    print(f"🌍 Lancement du robot d'audit sur : {url_a_tester}")
    print("⏳ Connexion en cours (simulation du navigateur Chrome)...")
    print("="*50)
    
    resultat = scrape_website(url_a_tester)
    
    if resultat.error:
        print(f"❌ Impossible d'analyser le site : {resultat.error}")
    else:
        print("✅ Code source téléchargé et analysé avec succès !")
        print(f"📊 Données Schema.org trouvées : {resultat.structured_data_types}")
        print("-" * 50)
        print("📍 RÉSULTATS GÉOGRAPHIQUES EXTRAITS :")
        print(f"🏢 Adresse   : {resultat.business_address}")
        print(f"🌍 Latitude  : {resultat.business_latitude}")
        print(f"🌍 Longitude : {resultat.business_longitude}")
        print(f"Nombre de mots détectés : {resultat.word_count}")
        print(f"'Pierre Stibbe' dans le contenu : {'Pierre Stibbe' in (resultat.main_content or '')}")
    print("="*50)

if __name__ == "__main__":
    test_site_reel()