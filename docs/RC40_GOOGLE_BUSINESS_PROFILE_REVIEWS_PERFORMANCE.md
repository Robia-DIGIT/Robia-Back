# RC40 — Avis et performances Google Business Profile (lecture seule)

RC38 a lu les détails de la fiche (identité, horaires). RC40 ajoute deux
lectures supplémentaires, toujours en lecture seule et toujours limitées au
propre profil de l'organisation connectée : les avis clients et les
statistiques de performance. Aucune nouvelle autorisation OAuth n'est
nécessaire — le scope `https://www.googleapis.com/auth/business.manage`
déjà accordé pour RC38 couvre les deux.

## Ce qui est ajouté

- `GET /integrations/google/business-profile/locations/:id/reviews` — avis
  déjà synchronisés, stockés en base (miroir read-only, comme les fiches).
- `POST /integrations/google/business-profile/locations/:id/reviews/sync` —
  relit tous les avis de cette fiche depuis Google (API `mybusiness.
  googleapis.com/v4` — Google n'a pas encore migré la gestion des avis vers
  une des APIs Business Profile dédiées les plus récentes), les met à jour
  en base et supprime les avis qui ne sont plus observés (même logique que
  la synchronisation des établissements : toutes les pages sont lues avant
  toute écriture, une panne à mi-pagination n'écrit et ne supprime rien).
- `GET /integrations/google/business-profile/locations/:id/performance` —
  interroge en direct la Performance API (`businessprofileperformance.
  googleapis.com/v1`) sur les 30 derniers jours (impressions carte/recherche
  desktop et mobile agrégées, appels, clics site, demandes d'itinéraire,
  conversations) et retourne un total + une série journalière. Rien n'est
  persisté ici (même logique que les statistiques GA4 existantes) : chaque
  appel relit Google.

Les trois routes sont scoping par organisation ET par établissement — une
fiche appartenant à une autre organisation renvoie 404, jamais les données
d'un tiers.

## Hors périmètre explicite

- **Répondre à un avis** — Google expose cette capacité (`reviewReply`) en
  écriture sur la même API v4, mais ROBIA ne l'appelle jamais. Le champ
  `replyComment`/`replyUpdateTime` mirroré ici est uniquement la réponse que
  le propriétaire a déjà postée directement sur Google, affichée pour
  information.
- **Modération, signalement ou suppression d'avis.**
- **Écriture d'aucune sorte** vers Business Profile — cette règle de RC38
  reste entière.

## Une limite à connaître avant la mise en production

Ce lot a été développé et testé (37 tests, mocks de l'API Google) sans accès
à un compte Google Business Profile réel ni à des identifiants OAuth de
production — comme RC38/RC39 avant lui pour leurs propres premières
itérations. Les noms de champs et le format des requêtes suivent la
documentation publique de Google au moment de l'écriture, mais n'ont pas été
validés contre une réponse réelle de :

- `mybusiness.googleapis.com/v4/{account}/{location}/reviews`
- `businessprofileperformance.googleapis.com/v1/{location}:fetchMultiDailyMetricsTimeSeries`

Avant d'annoncer cette fonctionnalité aux utilisateurs, un test manuel contre
un vrai compte connecté (au moins un établissement avec des avis existants,
et un établissement avec au moins quelques semaines d'historique de
performance) est nécessaire pour confirmer que les formats de requête/
réponse ci-dessus sont exacts.

## Configuration

Aucune variable d'environnement supplémentaire. Les deux nouvelles APIs
(`My Business API` pour les avis — encore active malgré son nom historique,
et `Business Profile Performance API`) doivent être activées dans le même
projet Google Cloud que RC38, avec le même client OAuth serveur.

## Migration

`20260922130000_gbp_reviews` — additive uniquement (nouvelle table
`google_business_profile_reviews`), aucune modification des tables
existantes.
