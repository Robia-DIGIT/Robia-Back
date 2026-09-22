# ROBIA Content Studio — contrat de conception v0.1

Date : 22 septembre 2026. Base backend inspectée : `2773c19`.
Statut : lot 1 backend ajouté à la PR draft ; aucune publication externe.

## Objectif produit

Transformer une opportunité SEO locale en contenu utile, approuvé et publié,
avec une preuve dans Actions. Le Copilot n'est pas un chat généraliste : il
connaît la cible, explique la recommandation et produit un document éditable.
Ne promettre ni classement Google garanti ni causalité entre publication et gain.

## Existant à réutiliser

- `PageIA.tsx` : contexte entreprise/site déjà présent, commandes désactivées.
- `DocumentsService` : génération, stockage, édition tenant-scopés par opportunité.
- `GenerateDocumentDto` : `local_page`, `faq`, `meta`, `gbp_post`, `review_reply`,
  `dev_brief`, `checklist`. Ne pas supprimer ces types pour simplifier la V1.
- Python `/documents` et provider factory : génération réelle déjà disponible.
  Le prompt ne reçoit actuellement que type/titre/description de l'opportunité.
- `ActionExecutionService` : soumission, approbation, événements et preuves.
  Sa preuve fournie par le client est une déclaration humaine, pas une preuve
  de publication distante. Conserver cette distinction à l'écran et en base.
- RC25/27 : ordonnanceur et reprises. Réutiliser les mécanismes, pas présumer
  que toutes les écritures Google/WordPress sont rejouables.
- RC38 : OAuth, secrets chiffrés, établissements et association à ROBIA.

## Répartition des responsabilités

- Codex : contrat, backend, persistance, contexte IA, connecteurs, sécurité,
  intégration Actions, tests de concurrence et revue indépendante du frontend.
- Claude : frontend premium `/ia`, documents/éditeur, aperçu, états asynchrones,
  parcours WordPress et liens depuis Actions/Mots-clés/Business Profile.
- Aucun fichier backend édité par Claude sur ce lot ; contrat d'API proposé
  ci-dessous à confirmer avant branchement. Les mocks restent dans les tests
  et les démonstrations explicitement identifiées, jamais en production.
- PR draft séparées, base main fraîche, pas de merge/déploiement sans autorisation.

## Livraisons verticales

0. Fondation : politique pure de publication + tests + ce contrat (présente PR).
1. Studio : génération libre tenant/site-scopée, brief réel, révision optimiste,
   bibliothèque par site et liaison optionnelle à une Action (présente PR).
2. WordPress : connexion sécurisée, import de contenus borné, création d'un
   brouillon WordPress et preuve distante ; publication avec validation explicite.
3. GBP : post standard approuvé, publication puis vérification du statut Google.
   Description de fiche = autre type d'action, diff et consentement distincts.
4. Planification : publication d'une révision approuvée à une date/fuseau précis,
   notifications, annulation, reprise contrôlée, rapport opérationnel.
5. Mesure : GSC, performance GBP et découverte de mots-clés autorisée.

## Modèle cible (migration additive à concevoir, pas encore implémentée)

Étendre `Document` au lieu de créer un second stockage de contenus :

- contexte immuable référencé : organizationId, websiteId, businessLocationId,
  opportunityId facultatif, actionItemId, locale, objectif, sources autorisées ;
- `DocumentRevision` immutable : version, contenu structuré, auteur, promptVersion,
  provider/model, empreinte, faits à vérifier, date ;
- `ContentApproval` : révision + empreinte du payload final + canal + cible +
  version de connexion + approbateur + révocation ;
- `PublicationAttempt` : identifiant d'opération unique, claimToken, bail,
  tentative, phase réseau, résultat, identifiant distant et erreur nettoyée ;
- WordPressConnection tenant/site-scopée : URL validée, credential chiffré,
  capacités réelles, version monotone (reconnexion/invalidation), statut.

Un contenu créé librement dans le Studio doit pouvoir créer une Action de
contenu sans fabriquer une opportunité d'audit. Examiner la relation Prisma
actuelle et la généraliser de manière additive et testée si elle est obligatoire.
Toute FK cible doit être vérifiée dans la même organisation ET le bon site.

## Séparer les états

Document : draft / generating / ready / needs_review / approved / archived.
Génération : queued / running / succeeded / failed.
Publication : queued / publishing / needs_reconciliation / pending_provider /
confirmed / failed / cancelled.

Une révision approuvée est immutable ; toute édition crée une nouvelle révision
et invalide l'autorisation de publier ce nouveau contenu. Changer cible, médias,
CTA, date de publication ou compte exige aussi une nouvelle validation.
Créer un brouillon WordPress n'est pas publier. Une réponse Google acceptée
mais encore en modération n'est pas une visibilité publique confirmée.

## Contrat de compatibilité livré par le lot 1 dans cette PR

- POST `/documents/generate` accepte `type`, `websiteId`, `brief` et
  `actionItemId?`; le mode historique avec `opportunityId` reste compatible.
- GET `/documents?website_id=...` expose une bibliothèque bornée à 100 éléments ;
  `opportunity_id` reste supporté. La pagination par curseur reste à ajouter.
- PATCH `/documents/:id` exige `expectedRevision`; un éditeur obsolète reçoit 409.
- Le brief est stocké, transmis au moteur Python et séparé des faits serveur.
- `ValidationLog` reste un journal historique. Le vrai parcours d'approbation et
  d'exécution est celui d'ActionItem ; aucune publication n'est branchée.

La migration rend `Document.opportunityId` nullable, ajoute `websiteId` obligatoire,
`brief` et `revision`, en rétro-remplissant le site via opportunité → audit.

## Contrat HTTP cible après le lot 1

Les routes ci-dessous restent une cible d'évolution et ne doivent pas être
appelées par le frontend tant qu'elles ne sont pas réellement livrées :

- GET `/copilot/context?websiteId=...` : facts, sources, connections, capabilities,
  warnings et cibles autorisées. Ne jamais retourner de credentials.
- POST `/copilot/generations` : `websiteId`, `businessLocationId?`,
  `opportunityId?`, `actionItemId?`, `documentType`, `locale`, `brief`,
  `idempotencyKey`. Réponse 202 avec generationId et documentId.
- GET `/copilot/generations/:id` : job, progression réelle, erreur nettoyée.
- GET `/copilot/documents?websiteId=...&cursor=...` : bibliothèque paginée.
- GET `/copilot/documents/:id` : révisions et état des destinations.
- PATCH `/copilot/documents/:id` : `expectedRevision` + contenu ; 409 si obsolète.
- POST `/copilot/documents/:id/approvals` : `revision`, `destination`, `targetId` ;
  hash et identité résolus côté serveur, jamais approuvés sur parole du client.
- POST `/copilot/documents/:id/publications` : `approvalId`, `idempotencyKey`,
  mode explicite `draft` ou `publish`. Date planifiée seulement au lot 4.

Les réponses exposent les capacités livrées, pas seulement la présence d'un token.
Pas de boutons actifs vers des routes non livrées. Pas d'organisation provenant
du body utilisée comme autorité. RBAC vérifié côté serveur, y compris au dispatch.

## Génération et SEO

- Contexte construit côté serveur, jamais des faits d'entreprise arbitraires
  fournis par le navigateur. Distinguer faits confirmés, sources et suggestions.
- Utiliser un corpus minimal : activité, services réels, zones servies, ton,
  URLs possédées, données GSC pertinentes et recommandations existantes.
- Contenus récupérés = données non fiables, jamais instructions système.
  Pas de secrets/PII ODC dans les prompts ; aucun outil d'écriture accessible au LLM.
- Sortie structurée validée : title, sections, CTA, suggestedMeta, factualWarnings.
  Sanitation du HTML et des liens avant aperçu/export ; échec visible, pas de faux succès.
- Contrôler la cannibalisation : préférer enrichir une URL pertinente existante.
  Pas de pages quasi identiques pour chaque ville ni de faux avis/offres/adresses.
- Files de génération persistantes, budget tokens/organisation, concurrence bornée,
  timeout, quotas, retry limité avant production d'un document, télémétrie sans prompts sensibles.
- Ne pas ajouter une base vectorielle ou un nouveau broker par réflexe : rester
  NestJS/Postgres + moteur Python existant jusqu'à un besoin de charge mesuré.

## Publication fiable

La politique pure ajoutée ici n'est ni une autorisation ni un verrou : le futur
service doit reconstruire ses entrées à partir de données serveur tenant-scopées.
En transaction : vérifier approbation/capacités/connexion, insérer une tentative
avec contrainte unique, réclamer le bail et produire un événement outbox durable.
Un seul worker possède l'opération ; la fin utilise un CAS sur claimToken.

Le digest doit couvrir tout le payload canonique : texte, CTA, média, destination,
mode draft/publish et éventuelle date. Le modèle minimal présent ne sérialise
pas ce payload : cette responsabilité appartient au futur adaptateur testé.

Un timeout après POST est ambigu : passer en needs_reconciliation. Ne jamais
rejouer simplement parce que le bail expire. La recherche distante peut aider,
mais une correspondance textuelle n'est pas une preuve universelle d'unicité.
En absence de preuve fiable, demander une résolution humaine. Un futur plugin
WordPress peut fournir une vraie clé d'opération persistante côté serveur distant.
Pas de promesse exactly-once distribuée sans support distant.

Pour une édition d'une page existante : snapshot avant/après, vérifier une
modification concurrente, afficher le diff et refuser d'écraser une nouvelle version.
Restaurer une ancienne version est une nouvelle opération validée, pas un undo gratuit.

## WordPress V1

WordPress auto-hébergé avec REST activée : HTTPS + Application Password révocable,
compte dédié à privilèges minimaux. Jamais le mot de passe principal, jamais localStorage.
WordPress.com OAuth est un adaptateur distinct, pas une capacité présumée de V1.
Évaluer les permissions sur le site réel ; ne pas exiger un administrateur.

SSRF : contrôler protocole, port, IP IPv4/IPv6 privée/réservée, DNS/rebinding,
redirections et hôtes ; épingler la destination validée au transport, jamais
transmettre Authorization vers une autre origine. Limites timeout/taille/pages.
Ne jamais interpoler l'URL utilisateur dans une commande shell.

V1 écrit des articles en brouillon et publie après consentement distinct.
Pages existantes, Elementor/Divi et autres builders : export/guide manuel tant
qu'un adaptateur compatible n'est pas testé. Pas d'écrasement de blocs builder.
Les meta SEO ne sont pas universellement éditables via le REST core ; Yoast
REST est en lecture seule. Marquer la capacité indisponible sans adaptateur testé.

## Google Business Profile

Utiliser localPosts pour les actualités standards ; ne pas confondre post et
description/catégories de la fiche. V1 sans modification de nom/adresse/catégories.
Google peut refuser un post ou une catégorie d'établissement : état explicite.
L'autorisation OAuth technique ne remplace pas le consentement à une publication.
Prévoir une revue conformité du traitement et de la durée de stockage des données
GBP AVANT ajout de snapshots/prompts persistants ; aucun historique brut illimité.
Séparer contenu rédigé par le client, métadonnées opérationnelles et cache Google.
La politique publiée impose notamment des limites de stockage de contenu API ;
ne pas en conclure que tout contenu peut être exporté vers un LLM tiers.
Pas d'analyse des concurrents via l'accès privé aux fiches administrées.

## Mots-clés : provenance obligatoire

1. Search Console : observations du site (clics, impressions, CTR, position moyenne).
   Paginer et filtrer ; les résultats ne sont pas garantis exhaustifs.
2. GBP Performance : requêtes de découverte mensuelles, impressions ou seuils.
   Un seuil ne doit pas être affiché comme une mesure exacte.
3. Google Ads Keyword Planning : idées/volumes estimés/ciblage géographique/langue.
   Accès distinct de GBP ; vérification accès et permissible use avant intégration.
   La concurrence publicitaire n'est pas une difficulté SEO organique.
4. Classement Maps sur grille : chantier distinct ; aucune de ces trois sources
   ne fournit à elle seule une grille de positions Maps par coordonnées.

Chaque métrique affiche source, période, territoire, fraîcheur et limites.
Ne pas sommer impressions GBP et GSC comme si elles étaient comparables.
Comparer fenêtres comparables (ex. 28 jours avant/après) sans attribuer une
variation au seul contenu. Pas de métrique par post non disponible dans l'API.

## Tests de recette indispensables avant ouverture

- Isolation tenant et mauvais site/cible ; autorisation révoquée au dispatch.
- Réponse LLM invalide, timeout, injection dans source, quotas et double-clic.
- Nouvelle révision/CTA/média/cible/connexion invalide l'approbation.
- Deux workers, crash avant/après appel, bail périmé, réponse perdue après succès.
- WordPress 401/403, REST bloquée, SSRF IPv6/DNS/redirect et credentials redactés.
- Brouillon créé != article publié ; Google accepté != publication visible.
- Édition distante concurrente jamais écrasée silencieusement.
- Parcours complet opportunité → génération → édition → approbation → publication
  simulée en intégration → preuve dans Actions, puis test staging autorisé.

## Sources primaires consultées le 22/09/2026

- https://localo.com/local-seo-tool/google-posts-schedule
- https://docs.localo.com/en/articles/11070186-what-is-localo-and-how-does-it-work
- https://developers.google.com/my-business/content/posts-data
- https://developers.google.com/my-business/content/policies
- https://developers.google.com/my-business/reference/performance/rest/v1/locations.searchkeywords.impressions.monthly/list
- https://developers.google.com/my-business/content/performance/change-log
- https://developers.google.com/webmaster-tools/v1/searchanalytics/query
- https://developers.google.com/google-ads/api/docs/keyword-planning/overview
- https://developers.google.com/google-ads/api/docs/api-policy/access-levels
- https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/
- https://developer.wordpress.org/rest-api/reference/posts/
- https://developer.yoast.com/customization/apis/rest-api/
- https://developers.google.com/search/docs/fundamentals/using-gen-ai-content
