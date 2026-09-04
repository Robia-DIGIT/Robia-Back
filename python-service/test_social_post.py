from dotenv import load_dotenv
load_dotenv()

from app.agents.generation import generate_social_post_suggestions

variants = generate_social_post_suggestions(
    business_name="Carlton Madagascar",
    sector="Hôtellerie",
    city="Antananarivo",
    weather_description="Couvert",
    temperature_c=16.8,
    opening_hours_today="Ouvert 24h/24",
    top_keywords=["chambres", "suites", "hôtel", "restaurants", "spa"],
)

for v in variants:
    print(f"\n--- {v['label']} ---")
    print(v["content"])