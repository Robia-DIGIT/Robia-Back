# RC42 — connecteur WordPress, brouillons uniquement

Statut : implémentation backend en PR draft. Aucun merge ni déploiement.

## Promesse exacte

RC42 connecte un site WordPress auto-hébergé à un `Website` ROBIA et peut créer
un **article ou une page au statut `draft`** depuis un `Document` approuvé et
lié à une `ActionItem`. Le connecteur ne publie jamais, ne met jamais à jour une
page existante et ne téléverse aucun média.

La connexion utilise un Application Password WordPress dédié. Le mot de passe
principal WordPress ne doit jamais être utilisé. Une déconnexion RC42 efface le
secret local, mais ne révoque pas le mot de passe d'application dans WordPress :
le client doit le révoquer dans son profil WordPress.

## Parcours HTTP livré

- `POST /integrations/wordpress/connect` : `websiteId`, `username`,
  `applicationPassword`. L'URL cible vient exclusivement du `Website` possédé
  par l'organisation. Le serveur vérifie `/wp-json/wp/v2/users/me?context=edit`
  avant de remplacer une connexion existante.
- `GET /integrations/wordpress/status?websiteId=...` : état, utilisateur distant,
  version de connexion et capacités `canCreatePosts` / `canCreatePages`, sans
  credential.
- `DELETE /integrations/wordpress?websiteId=...` : déconnexion locale explicite.
- `POST /integrations/wordpress/draft-approvals` : fige la révision, le payload
  canonique, son SHA-256, le type `post|page`, la cible et la version de connexion.
- `DELETE /integrations/wordpress/draft-approvals/:id` : révocation locale.
- `POST /integrations/wordpress/drafts` : crée une seule tentative durable pour
  l'approbation exacte et envoie obligatoirement `status: "draft"`.
- `POST /integrations/wordpress/drafts/:attemptId/reconcile` : recherche en
  lecture seule une création dont la réponse réseau a été perdue.
- `GET /integrations/wordpress/attempts?websiteId=...` : historique borné à 100,
  sans secret ni payload de credential.

Toutes les routes sont protégées par JWT, `OrgScopeGuard` et le throttling global.
Les routes de connexion/écriture/réconciliation ont en plus une limite locale.

## Approbation et preuve

L'approbation générique de l'Action reste obligatoire, mais elle ne suffit pas :
`WordPressDraftApproval` lie aussi exactement :

- organisation, document et révision ;
- empreinte du payload réellement envoyé ;
- type WordPress (`post` ou `page`) ;
- connexion et version de connexion ;
- approbateur et date de révocation.

Une édition du document, une reconnexion, une déconnexion, un changement de type
ou une révocation rendent l'approbation inutilisable. Après confirmation distante,
la preuve (`remotePostId`, URL publique éventuelle, URL éditeur, mode `draft_only`)
est enregistrée dans l'Action et son journal d'exécution.

## Idempotence et réponses ambiguës

La base impose une tentative unique par approbation et par `operationKey`. Deux
clics concurrents ne produisent donc pas deux POST. Un timeout, une coupure réseau,
une réponse trop grande ou un HTTP 5xx après le POST donne `status=unknown`.
Cette tentative n'est jamais rejouée automatiquement, même après expiration du
bail.

Le payload contient un commentaire HTML ROBIA non visible et un slug déterministe.
La réconciliation fait un GET authentifié par slug puis exige exactement un
résultat contenant ce marqueur. Zéro ou plusieurs résultats conservent `unknown`
et exigent une vérification humaine. Ce mécanisme réduit le risque de doublon mais
ne constitue pas une garantie distributed exactly-once offerte par WordPress.

## Défense SSRF et secrets

- HTTPS obligatoire, port 443 implicite uniquement ; aucune URL avec credential,
  fragment, IP littérale ou `localhost` ;
- résolution DNS contrôlée avant l'appel ; toute réponse IPv4/IPv6 privée,
  locale, réservée, de documentation ou multicast entraîne un refus ;
- l'adresse validée est épinglée dans le callback `lookup` de la connexion TLS,
  ce qui ferme la fenêtre classique « valider puis refaire une résolution » ;
- aucun suivi de redirection ; `Authorization` ne peut donc pas changer d'origine ;
- timeout 10 secondes, requête et réponse limitées à 1 Mio ;
- Application Password chiffré en AES-256-GCM avec AAD
  `organizationId:websiteId` et clé dédiée
  `WORDPRESS_CREDENTIAL_ENCRYPTION_KEY` (64 hex) ;
- aucun secret, en-tête Authorization ou corps d'erreur WordPress n'est persisté,
  renvoyé ou journalisé.

## Données exclues de RC42

- publication immédiate ou planifiée ;
- édition/suppression de contenu existant ;
- médias, catégories, tags, commentaires ;
- champs SEO Yoast/Rank Math et builders Elementor/Divi ;
- WordPress.com OAuth, multisite et authentification par mot de passe principal ;
- import/crawl de contenu WordPress ;
- activation de plugin, thème ou code distant.

## Validation avant ouverture

1. migration additive sur une base jetable via le garde Prisma ;
2. suite Jest, build, Prisma validate et baseline ESLint exacte ;
3. tests SSRF, isolation tenant, révision/connexion périmée, double clic, perte de
   réponse, perte de claim, 401/403/5xx et redaction ;
4. test manuel sur un WordPress de staging isolé avec un compte auteur dédié ;
5. vérifier dans l'admin que l'objet est bien `draft`, puis le supprimer à la main ;
6. revue Codex, revue humaine, PR maintenue draft jusqu'au feu vert explicite.

## Risques résiduels

- WordPress core ne fournit pas de clé d'idempotence distante universelle ; une
  réponse perdue peut donc nécessiter une inspection humaine.
- La déconnexion locale ne révoque pas le credential distant.
- Les proxies/CDN WordPress doivent préserver l'authentification Basic HTTPS.
- La compatibilité de plugins/builders n'est pas couverte ; RC42 ne touche que
  les champs REST core `title`, `content`, `slug`, `status`.
