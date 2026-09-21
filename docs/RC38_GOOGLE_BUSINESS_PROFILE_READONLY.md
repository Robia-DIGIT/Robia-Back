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
