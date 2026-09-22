# RC40 — Avis et performances Google Business Profile (lecture seule)

RC38 a lu les détails de la fiche (identité, horaires). RC40 ajoute deux
lectures supplémentaires, toujours en lecture seule et toujours limitées au
propre profil de l'organisation connectée : les avis clients et les
statistiques de performance. Aucune nouvelle autorisation OAuth n'est
nécessaire — le scope `https://www.googleapis.com/auth/business.manage`
déjà accordé pour RC38 couvre les deux.

**Confirmation explicite : ROBIA n'écrit jamais rien vers Google Business
Profile dans ce lot.** Ni les avis (pas de réponse, pas de signalement, pas
de suppression), ni les performances. Les trois routes RC40 ci-dessous sont
des lectures pures ; la seule écriture qui existe dans ce module est
l'écriture dans la base ROBIA elle-même (le miroir local des avis).

## Endpoints Google effectivement utilisés

- `GET https://mybusiness.googleapis.com/v4/{account}/{location}/reviews`
  (pagination par `pageToken`, taille de page 50) — Google n'a pas encore
  migré la gestion des avis vers une des APIs Business Profile dédiées les
  plus récentes ; c'est la seule surface qui les expose. La réponse inclut
  aussi `averageRating` et `totalReviewCount` — calculés par Google sur
  l'ensemble des avis de l'établissement, pas seulement la page courante.
- `GET https://businessprofileperformance.googleapis.com/v1/{location}:fetchMultiDailyMetricsTimeSeries`
  — fenêtre glissante des 30 derniers jours complets (hier inclus, aujourd'hui
  exclu car incomplet), métriques : impressions carte/recherche desktop et
  mobile, appels, clics site, demandes d'itinéraire, conversations.

## Ce qui est exposé par l'API ROBIA

### `GET /integrations/google/business-profile/locations/:id/reviews`

Retourne un DTO explicite, jamais les lignes Prisma brutes :

```json
{
  "reviews": [
    {
      "id": "...",
      "googleReviewName": "...",
      "reviewerDisplayName": "...",
      "starRating": 5,
      "comment": "...",
      "createTime": "...",
      "updateTime": "...",
      "replyComment": "...",
      "replyUpdateTime": "...",
      "lastSyncedAt": "...",
      "expiresAt": "..."
    }
  ],
  "averageRating": 4.7,
  "totalReviewCount": 132,
  "lastSyncedAt": "...",
  "expiresAt": "..."
}
```

`organizationId` et `locationId` ne sont jamais renvoyés (déjà connus du
client via l'URL/le contexte de session). `reviewerPhotoUri` a été retiré du
stockage et de l'API : le frontend ne l'affiche pas, aucune raison de le
conserver. `averageRating`/`totalReviewCount` sont **toujours** les valeurs
renvoyées par Google (`reviews.list`), jamais recalculées à partir des avis
stockés — les recalculer serait à la fois inexact (Google les calcule sur la
totalité de l'historique, pas seulement les avis actuellement en cache) et
contraire aux conditions d'utilisation de l'API (interdiction de manipuler/
agréger le contenu stocké).

Si le cache a expiré ou qu'aucune synchronisation n'a jamais eu lieu,
`averageRating`, `totalReviewCount`, `lastSyncedAt` et `expiresAt` valent
`null` et `reviews` est vide — jamais de valeur périmée servie en silence.

### `POST /integrations/google/business-profile/locations/:id/reviews/sync`

Relit tous les avis de cette fiche depuis Google et retourne
`{ synced, reviewCount, averageRating, totalReviewCount, syncedAt,
expiresAt }`. Réponses d'erreur : `409 Conflict` si une synchronisation est
déjà en cours pour cet établissement, `429 Too Many Requests` si le délai de
repos n'est pas écoulé.

### `GET /integrations/google/business-profile/locations/:id/performance`

Retourne `{ locationId, startDate, endDate, summary, daily, syncedAt }` —
`startDate`/`endDate` au format `YYYY-MM-DD`, `daily` une entrée par jour de
la fenêtre. Rien n'est persisté : chaque appel relit Google. Réponses
d'erreur : `409 Conflict` / `429 Too Many Requests`, mêmes règles que pour
les avis.

Les trois routes sont scopées par organisation ET par établissement — une
fiche appartenant à une autre organisation renvoie 404, jamais les données
d'un tiers.

## Politique de rétention (conformité Google)

Les conditions d'utilisation de l'API Google Business Profile plafonnent le
stockage de contenu tiers issu de l'API à **30 jours** et interdisent de
manipuler ou d'agréger ce contenu stocké (voir la section précédente sur
`averageRating`/`totalReviewCount`).

ROBIA retient volontairement beaucoup moins que ce plafond :

- **Fraîcheur cible : 24 heures.** Chaque avis stocké (`expiresAt`) et le
  cache de l'agrégat Google (`reviewsCacheExpiresAt` sur la fiche) expirent
  24h après la synchronisation qui les a produits — donc très strictement
  sous la limite de 30 jours imposée par Google.
- **Un avis expiré n'est jamais renvoyé**, même si la purge planifiée n'est
  pas encore passée : `listReviews()` filtre systématiquement sur
  `expiresAt > now()` avant de répondre, et l'agrégat n'est renvoyé que si
  `reviewsCacheExpiresAt` est encore dans le futur. La purge n'est donc pas
  le mécanisme d'application de la politique, seulement un nettoyage
  d'hygiène.
- **Purge automatique** : une tâche planifiée (`@Cron(EVERY_HOUR)`,
  `GoogleBusinessProfileService.purgeExpiredReviews()`) supprime
  définitivement tout avis dont `expiresAt <= now()`.
- Deux index dédiés (`expiresAt`, `lastSyncedAt`) évitent qu'un balayage de
  purge ou un filtrage de lecture dégénère en scan de table complet.
- Les statistiques de performance ne sont **jamais** mises en cache de façon
  permanente — chaque lecture relit Google en direct. Si un cache temporaire
  devait être introduit un jour, il devrait respecter la même politique de
  rétention stricte (jamais plus de 30 jours, idéalement alignée sur les 24h
  ci-dessus).

## Concurrence et protection de quota (claim/bail)

Même modèle que RC25 (`AutomationSchedulerService`) et RC38
(synchronisation des fiches) : un jeton de claim opaque, prouvé à nouveau
juste avant la transaction finale.

### Synchronisation des avis (`syncReviews`)

- Champs de claim sur `GoogleBusinessProfileLocation` :
  `reviewsSyncClaimedAt`, `reviewsSyncClaimToken`,
  `reviewsLastSyncAttemptAt`, `reviewsLastSyncedAt`, `reviewsSyncStatus`.
- Bail de claim : **5 minutes** (récupération automatique si un worker
  plante en cours de synchronisation).
- Délai de repos (cooldown) entre deux tentatives : **60 secondes**.
- `409 Conflict` si une synchronisation est déjà en cours (claim actif et
  non expiré) ; `429 Too Many Requests` si le cooldown n'est pas écoulé.
- Le claim est acquis **avant** tout appel à Google (y compris le
  rafraîchissement du jeton d'accès OAuth) : un appel concurrent ou en
  cooldown ne coûte donc aucune requête Google.
- Toutes les pages de Google sont lues avant la moindre écriture en base.
  Une erreur de pagination ne modifie strictement rien.
- La transaction finale reprouve la possession du claim (`updateMany` sur
  `id` + `reviewsSyncClaimToken`) **avant** tout upsert/suppression. Si un
  autre worker a repris la main entre-temps (bail expiré, nouveau claim), la
  transaction n'écrit rien et l'appel échoue avec `409 Conflict`.

### Lecture des performances (`getPerformanceMetrics`)

- Champs de claim sur `GoogleBusinessProfileLocation` :
  `performanceClaimedAt`, `performanceClaimToken`,
  `performanceLastAttemptAt`.
- Bail de claim : 5 minutes. Cooldown : **60 secondes minimum**, appliqué
  côté serveur — le bouton désactivé du frontend n'est qu'un confort
  d'affichage, jamais le mécanisme de protection réel.
- `409 Conflict` pendant une lecture en cours, `429 Too Many Requests`
  pendant le cooldown.
- Le claim est libéré dès que la lecture se termine (succès ou échec) —
  aucune donnée de performance n'est conservée entre deux appels.

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

Ce lot a été développé et testé (mocks de l'API Google, aucun accès à un
compte réel) — comme RC38/RC39 avant lui pour leurs propres premières
itérations. Les noms de champs et le format des requêtes suivent la
documentation publique de Google au moment de l'écriture, mais n'ont pas été
validés contre une réponse réelle de :

- `mybusiness.googleapis.com/v4/{account}/{location}/reviews`
- `businessprofileperformance.googleapis.com/v1/{location}:fetchMultiDailyMetricsTimeSeries`

Avant d'annoncer cette fonctionnalité aux utilisateurs, un test manuel
contrôlé contre un vrai compte connecté est nécessaire : un établissement
avec des avis existants (avec pagination si le volume le permet), une
synchronisation répétée (pour valider le comportement du claim/cooldown en
conditions réelles), un établissement avec au moins quelques semaines
d'historique de performance, et une vérification visuelle que les données
affichées correspondent à la réalité du compte Google.

**Aucun merge ni déploiement de ce lot sans une nouvelle revue Codex et un
feu vert humain explicite après ce test manuel.**

## Suivi requis — audit de rétention séparé pour RC38 (clos par RC41)

**Traité par RC41** (voir docs/RC38_GOOGLE_BUSINESS_PROFILE_READONLY.md,
section « RC41 — Politique de rétention et resynchronisation automatique »).
La fiche complète RC38 (identité, horaires, adresse, catégories, etc. —
`GoogleBusinessProfileLocation`) n'avait, à l'inverse des avis, aucune
politique d'expiration ni de purge — uniquement un bouton « Synchroniser »
manuel. RC41 ajoute une resynchronisation automatique planifiée (toute
connexion jamais synchronisée ou stale >24h), qui réutilise le bail de
synchronisation déjà existant, plutôt qu'une politique de purge : contrairement
aux avis, effacer une fiche établissement serait destructeur pour le produit,
alors qu'un rafraîchissement automatique atteint la même garantie de
conformité (jamais plus de 24h de retard sur Google, très en dessous du
plafond de 30 jours) sans jamais montrer un état vide à l'utilisateur.

Réserve inchangée : le texte exact des conditions Google n'a pas pu être relu
directement (accès réseau bloqué dans l'environnement de développement) —
seulement via des résultats de recherche qui le citent. À vérifier directement
sur `developers.google.com/my-business/content/policies` avant toute annonce
publique.

## Configuration

Aucune variable d'environnement supplémentaire. Les deux APIs (`My Business
API` pour les avis — encore active malgré son nom historique, et `Business
Profile Performance API`) doivent être activées dans le même projet Google
Cloud que RC38, avec le même client OAuth serveur.

## Migrations

- `20260922130000_gbp_reviews` — création de la table
  `google_business_profile_reviews` (additive uniquement).
- `20260922140000_gbp_reviews_retention_and_claims` — retrait de
  `reviewer_photo_uri`, ajout de `expires_at` (avec backfill à
  `last_synced_at + 24h` puis passage en `NOT NULL`) et de deux index
  (`expires_at`, `last_synced_at`) sur `google_business_profile_reviews` ;
  ajout des champs de claim/bail avis + performance et de l'agrégat Google
  mis en cache sur `google_business_profile_locations`.
