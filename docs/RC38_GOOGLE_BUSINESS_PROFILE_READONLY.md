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
3. Le refresh token est chiffré AES-256-GCM avant toute écriture en base.
4. `POST /integrations/google/business-profile/sync` lit les comptes via
   Account Management API puis leurs établissements via Business Information
   API. La pagination est suivie sur les deux APIs.
5. Chaque établissement Google est stocké comme miroir read-only et peut être
   associé à une `Location` appartenant à la même organisation ROBIA.
6. La déconnexion tente une révocation Google puis supprime la connexion et les
   miroirs associés par cascade.

L'adaptateur Intelligence GBP expose désormais l'état réel : `not_connected`,
`not_configured` tant qu'aucune synchronisation n'a abouti, puis `ok` avec le
nombre d'établissements observés. Ces données restent hors score SEO.

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

## Fiche complète (suivi de revue)

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

Migration `20260921140000_gbp_full_profile_fields` — additive, colonnes
nullables ou à défaut vide ; aucun backfill nécessaire, la synchronisation
suivante les peuple.

## Stockage frontend historique

La page `/business-profile` n'utilise plus `localStorage` comme source de
vérité. Si la base ne contient encore aucun établissement mais que l'ancien
cache `robia_business_locations` existe, la page le transfère une seule fois au
backend et ne supprime le cache qu'après réussite complète.

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
6. Déconnecter et vérifier que le statut revient à `Non connecté` sans aucune
   modification de la fiche dans Google.
