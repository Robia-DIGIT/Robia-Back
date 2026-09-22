# RC38 — Google Business Profile en lecture seule

RC38 active le connecteur préparé dans l'interface ROBIA. Google reste la
source de vérité : ce lot ne publie, ne modifie et ne supprime rien dans
Business Profile.

## Parcours livré

1. `GET /integrations/google/business-profile/authorize` crée un état OAuth
   signé, lié à l'organisation et à son propriétaire, puis retourne l'URL
   Google.
2. Le callback vérifie à la fois le cookie HTTP-only et la signature/expiration
   de l'état avant d'échanger le code.
3. Le refresh token est chiffré AES-256-GCM avant toute écriture en base et
   lié au `sub` Google stable. Un token existant n'est jamais réutilisé pour
   un autre compte, même si Google omet un nouveau refresh token.
4. `POST /integrations/google/business-profile/sync` lit les comptes via
   Account Management API puis leurs établissements via Business Information
   API. La pagination est suivie sur les deux APIs.
5. Chaque établissement Google est stocké comme miroir read-only et peut être
   associé à une `Location` appartenant à la même organisation ROBIA.
6. Une synchronisation possède un bail durable et un cooldown : une seule
   instance réconcilie un compte à la fois, et aucune suppression ne commence
   avant la lecture complète de toutes les pages Google.
7. La déconnexion supprime la connexion locale seulement après confirmation
   HTTP de la révocation Google. Une erreur conserve le token chiffré afin que
   l'utilisateur puisse réessayer.

L'adaptateur Intelligence GBP expose désormais l'état réel : `not_connected`,
`not_configured` tant qu'aucune synchronisation n'a abouti, puis `ok` avec le
nombre d'établissements observés. Une tentative incomplète expose `partial`
et conserve la date ainsi que les données de la dernière réussite ; le Command
Center ne la présente jamais comme `ok`. Ces données restent hors score SEO.

## Configuration production

Réutiliser le client OAuth Google serveur existant, mais ajouter cette URI de
redirection exacte dans Google Cloud Console :

```text
https://api.robiacopilot.site/integrations/google/business-profile/callback
```

Variables requises :

```dotenv
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_BUSINESS_PROFILE_REDIRECT_URI=https://api.robiacopilot.site/integrations/google/business-profile/callback
GOOGLE_TOKEN_ENCRYPTION_KEY=... # 64 caractères hexadécimaux
GOOGLE_OAUTH_STATE_SECRET=...   # 64 caractères hexadécimaux
GOOGLE_BUSINESS_PROFILE_TIMEOUT_MS=10000
```

Les APIs `My Business Account Management API` et `My Business Business
Information API` doivent être activées. Le scope demandé est uniquement
`https://www.googleapis.com/auth/business.manage`, accompagné de `openid email`
pour identifier le compte affiché dans ROBIA.

## Détails de la fiche synchronisés

Le lot initial ne lisait que `title`/`storeCode`/`storefrontAddress`/
`phoneNumbers.primaryPhone`/`websiteUri`/`categories.primaryCategory`/
`metadata`. Un retour utilisateur a montré qu'une fiche connectée
n'affichait presque rien de ce que Google connaît réellement de
l'établissement. Le `readMask` (et le miroir Prisma) couvre désormais aussi :
`languageCode`, `phoneNumbers.additionalPhones`,
`categories.additionalCategories`, `regularHours`, `specialHours`,
`moreHours`, `serviceArea`, `labels`, `latlng`, `openInfo.status` et
`profile.description`.

Délibérément exclus : `relationshipData` (relations de chaîne/succursales),
`serviceItems` (catalogue de services structuré, pertinent seulement pour
certains types d'établissements) et `adWordsLocationExtensions` (marqué
obsolète par Google). Toujours en lecture seule : aucun de ces champs
supplémentaires n'est jamais renvoyé à Google, uniquement affiché dans
ROBIA.

Il ne s'agit donc pas d'une copie exhaustive de tout Google Business Profile.
Les attributs, avis, médias/photos et performances relèvent d'autres endpoints
ou APIs et restent hors périmètre de RC38. L'interface parle volontairement de
« détails de la fiche », jamais de « fiche complète ».

Migration `20260921140000_gbp_full_profile_fields` — additive, colonnes
nullables ou à défaut vide ; aucun backfill nécessaire, la synchronisation
suivante les peuple.

Migration de durcissement
`20260921150000_rc38_oauth_sync_and_legacy_import` — additive : identité
Google stable, tentative/statut/bail de synchronisation et clé idempotente de
l'import legacy. Les connexions déjà synchronisées sont reclassées `success` ;
les autres restent `never`.

## Stockage frontend historique

La page `/business-profile` n'utilise plus `localStorage` comme source de
vérité. Si l'ancien cache `robia_business_locations` existe, elle l'envoie à
`POST /locations/legacy-import`. L'import est transactionnel et idempotent par
organisation/identifiant legacy : un échec ne laisse aucun lot partiel, une
réponse réseau perdue peut être rejouée sans doublon, et une base déjà
partiellement migrée est réconciliée. Le cache navigateur n'est supprimé
qu'après réussite complète.

## Publication OAuth

L'approbation d'accès aux APIs Google Business Profile ne publie pas
automatiquement l'application OAuth. Tant que Google Auth Platform reste en
mode **Test**, seuls les utilisateurs tests configurés peuvent consentir et
leurs autorisations/refresh tokens peuvent expirer après sept jours. Avant
d'ouvrir ROBIA à des utilisateurs réels, publier l'application depuis l'écran
Audience et terminer les validations de marque/scopes demandées par Google.

## RC41 — Politique de rétention et resynchronisation automatique

**Suivi clos.** RC40 (avis + performances) avait signalé que la fiche
établissement RC38 n'avait, à l'inverse des avis, aucune politique
d'expiration ni de resynchronisation automatique — uniquement un bouton
« Synchroniser » manuel. Les conditions d'utilisation des Business Profile
APIs plafonnent le stockage de tout contenu obtenu via ces APIs à **30 jours
calendaires** (« you cannot ... store any content provided through the
Business Profile APIs ... except ... no more than 30 calendar days ») — une
formulation qui ne se limite pas aux avis et couvre a priori aussi les
données de fiche (adresse, horaires, catégories, téléphone). Une organisation
qui ne recliquait jamais sur « Synchroniser » pouvait donc conserver une
copie Google en base indéfiniment, au-delà de ce plafond.

RC41 corrige cela sans migration de schéma, en réutilisant intégralement le
bail/claim de synchronisation déjà construit pour le bouton manuel
(`syncClaimedAt`/`syncClaimToken`/`lastSyncAttemptAt` sur
`GoogleBusinessProfileConnection`) :

- **Resynchronisation planifiée** (`@Cron(EVERY_HOUR)`,
  `GoogleBusinessProfileService.refreshStaleLocations()`) : toute connexion
  jamais synchronisée ou dont `lastSyncedAt` dépasse 24h est resynchronisée
  automatiquement, sans action utilisateur — très en dessous du plafond de 30
  jours. Le job est un no-op la plupart des heures : il ne resynchronise
  chaque connexion qu'une fois par jour au plus.
- **Même bail que la synchronisation manuelle** : le cron appelle exactement
  le même chemin de code (claim → lecture complète Google → transaction →
  libération) qu'un clic manuel. Les deux se disputent le même bail — jamais
  de double appel Google concurrent, jamais de course.
- **Panne isolée par connexion** : l'échec d'une organisation (jeton révoqué,
  claim déjà détenu par une synchronisation manuelle en cours, erreur Google
  transitoire) est journalisé et n'interrompt jamais le traitement des autres
  organisations dans le même passage du cron.
- **Signal de fraîcheur honnête** : `GET .../status` expose désormais
  `stale: boolean` (vrai si `lastSyncedAt` est absent ou dépasse 24h) — pour
  détecter le cas où la resynchronisation planifiée échoue elle-même de façon
  persistante, plutôt que de servir silencieusement une donnée vieillissante
  sans jamais le signaler.

**Réserve** : le texte exact des conditions Google n'a pas pu être relu
directement depuis l'environnement de développement (accès réseau à
`developers.google.com` bloqué) — seulement via des résultats de recherche
qui le citent. À vérifier directement sur
`developers.google.com/my-business/content/policies` avant toute annonce
publique. L'implémentation ci-dessus reste correcte dans tous les cas : elle
ne fait que garantir un rafraîchissement automatique d'une donnée déjà
resynchronisable, sans aucune perte fonctionnelle si la règle se révèle en
pratique plus étroite qu'anticipé.

## Hors périmètre explicite

- création ou modification d'une fiche Google ;
- publication de posts ;
- réponse aux avis ;
- suppression Google ;
- génération d'opportunités à partir de règles GBP.

Ces écritures devront passer par un lot séparé avec validation humaine,
idempotence, journal de preuve et permissions Google revues.

## Smoke test après déploiement

1. Appliquer la migration Prisma.
2. Ouvrir `/business-profile`, créer ou vérifier un établissement ROBIA.
3. Cliquer **Connecter Google Business Profile** et accepter le consentement.
4. Vérifier le retour `?gbp=connected`, la synchronisation et l'adresse e-mail
   du compte.
5. Associer une fiche Google à un établissement ROBIA, recharger la page et
   vérifier que l'association persiste.
6. Reconnecter le même compte sans mélanger les établissements, puis essayer
   un autre compte et vérifier que les anciens miroirs ne sont pas présentés
   comme appartenant au nouveau.
7. Déconnecter et vérifier que le statut revient à `Non connecté` seulement
   après confirmation de la révocation Google, sans modifier la fiche.
