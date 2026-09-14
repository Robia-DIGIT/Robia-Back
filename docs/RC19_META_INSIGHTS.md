# RC19 — Meta Insights → Opportunités ROBIA

RC19 transforme les données Meta déjà connectées en lecture seule par RC18
(`GET /integrations/meta/performance`, `docs/RC18_META_READONLY.md`) en
signaux explicables, puis en `Opportunity` ROBIA — sans jamais toucher au
score SEO (`seo_score_v2` / `Audit.globalScore`).

## Où vit le code

- `src/integrations/meta.service.ts` — nouvelle méthode
  `getInsightSignals(organizationId)`. Ne lève jamais d'exception (même
  contrat que `GoogleSearchConsoleService.getSearchConsoleSignalsForAudit`,
  RC-13) : chaque lecture (Prisma, déchiffrement du jeton, chaque appel
  Graph) est protégée indépendamment ; une panne dégrade vers
  `status: 'unavailable'` au lieu de faire échouer la génération
  d'opportunités. Distincte de `getPerformance()` (RC-18, utilisée par
  `/meta-data`) pour ne pas toucher ce chemin existant.
- `src/integrations/meta-insights.ts` — `evaluateMetaFindings()`, fonction
  pure (aucune I/O), qui applique les 5 règles déterministes ci-dessous à
  `MetaAuditSignals`.
- `src/opportunities/opportunities.service.ts` —
  `generateFromAudit()`/`generateFromSiteAudit()` évaluent désormais aussi
  les signaux Meta courants et convertissent chaque `MetaFinding` en
  `Opportunity` (même table que les opportunités SEO, `auditId` obligatoire
  côté schéma Prisma). Additif uniquement : les opportunités SEO existantes
  ne sont ni modifiées ni réordonnées.

## Échelle impact/effort (0-10, partagée avec le SEO)

`impact_score`/`effort_score` sont des entiers `0-10`, exactement la même
échelle que celle utilisée par `python-service/app/agents/audit_rules.py`
pour les opportunités SEO (`SEVERITY_WEIGHTS`). Ce n'est pas un détail
cosmétique : le frontend (`oppPriorityScore()`) retombe sur
`impactScore * 10` en absence d'autre signal, et
`OpportunitiesService.findAllForAudit()` trie l'ensemble des opportunités
(SEO + Meta confondues) par `impactScore desc` avec `take: 5`. Une échelle
Meta différente (ex. 20-50) aurait mécaniquement faussé ce classement et
pu évincer des opportunités SEO plus prioritaires. Valeurs actuelles par
règle : `META_PAGE_NOT_SELECTED` (4/1), `META_INSTAGRAM_NOT_LINKED` (3/2),
`META_NO_RECENT_MEDIA` (5/4), `META_LOW_RECENT_ACTIVITY` (4/4),
`META_PROFILE_DATA_INCOMPLETE` (2/2). Couvert par un test dédié dans
`meta-insights.spec.ts` qui vérifie que chaque règle reste dans `[0, 10]`.

## Régénération : ajout des Meta manquantes sans jamais toucher au SEO existant

`generateFromAudit()`/`generateFromSiteAudit()` restent idempotents pour le
SEO : si des opportunités existent déjà pour un audit, elles ne sont
jamais recréées ni supprimées (elles peuvent porter des actions,
documents ou validations liés). RC-19 ajoute cependant un comportement
correctif : sur ce chemin déjà-généré, `syncMissingMetaOpportunities()`
réévalue les signaux Meta courants et insère uniquement les `MetaFinding`
qui n'ont pas encore d'opportunité enregistrée pour cet audit — utile
lorsque Meta est connecté _après_ qu'un audit a déjà été exécuté (ex. clic
sur « Actualiser les opportunités »). L'identité stable d'un finding Meta
est la paire `(source: 'meta', ruleCode)` scoping par `auditId`
(`existingMetaRuleCodes()`), lue depuis `Opportunity.sourceData`. Si aucune
règle n'est manquante, aucune écriture n'a lieu (pas de `$transaction`
vide). Couvert par tests dédiés dans `opportunities.service.spec.ts` :
ajout d'une Meta manquante sur un audit déjà généré, et absence totale
d'écriture quand tout est déjà présent (ré-exécution idempotente).

### Le listing reste source-aware (Codex review)

Une Meta peut désormais être créée en base sur un audit qui a déjà 5
opportunités SEO ou plus (via `syncMissingMetaOpportunities()`
ci-dessus) — mais `findAllForAudit()` faisait un simple
`orderBy: impactScore desc, take: 5` sur SEO **et** Meta confondues :
avec 5 opportunités SEO à impact plus élevé déjà présentes, la Meta
nouvellement créée pouvait être exclue du résultat retourné, bien que
présente en base, et donc réapparaître comme « invisible » après
rechargement. `findAllForAudit()` sépare maintenant les deux ensembles :
le top 5 SEO garde son classement et son plafond inchangés, et **toutes**
les opportunités Meta de l'audit (au plus 5, une par règle) sont
toujours ajoutées au résultat, sans jamais évincer le SEO ni être
évincées par lui. Couvert par un test dédié
(`opportunities.service.spec.ts`, « Codex review ») : 5 opportunités SEO
à impact 9 + 1 opportunité Meta à impact 3, la Meta reste présente dans
le résultat.

## Les 5 règles

Chaque règle ne se déclenche que lorsque l'absence est réellement
observée — jamais par déduction. Toutes portent `source: 'meta'`,
`scoreInfluence: false`, une preuve factuelle (`evidence`), une
recommandation, et un niveau de confiance (`'observed'` = fait constaté
directement, `'heuristic'` = seuil documenté, pas une vérité métier).

| Règle                          | Condition de déclenchement                                                                                | Confiance |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | --------- |
| `META_PAGE_NOT_SELECTED`       | Meta connecté, aucune Page Facebook active sélectionnée                                                   | observed  |
| `META_INSTAGRAM_NOT_LINKED`    | Page sélectionnée, aucun compte Instagram professionnel lié                                               | observed  |
| `META_NO_RECENT_MEDIA`         | Instagram lié, lecture des médias réussie, 0 média retourné                                               | observed  |
| `META_LOW_RECENT_ACTIVITY`     | Instagram lié, médias présents, mais moins de N publications sur les M derniers jours (seuil heuristique) | heuristic |
| `META_PROFILE_DATA_INCOMPLETE` | Lecture de la Page réussie, mais `fanCount` ET `followersCount` non retournés par l'API Meta              | observed  |

`META_PAGE_NOT_SELECTED` court-circuite les autres règles : tant qu'aucune
Page n'est choisie, rien d'autre n'est réellement observable — les évaluer
quand même produirait soit un doublon de la même cause racine, soit une
absence fabriquée.

### Heuristique `META_LOW_RECENT_ACTIVITY`

- Seuil : `lowActivityMinPosts` publications sur une fenêtre glissante de
  `lowActivityWindowDays` jours. Défaut (`DEFAULT_META_INSIGHTS_THRESHOLDS`
  dans `meta-insights.ts`) : 30 jours / 1 publication.
- **Réellement configurable** via `MetaService.getInsightsThresholds()`,
  qui lit les variables d'environnement `META_LOW_ACTIVITY_WINDOW_DAYS`
  (entier `[1, 365]`) et `META_LOW_ACTIVITY_MIN_POSTS`. Toute valeur
  absente, non numérique ou hors bornes retombe silencieusement sur le
  défaut — jamais d'exception liée à la configuration.
- Garde-fou : `getInsightSignals()` ne récupère que les `RECENT_MEDIA_FETCH_LIMIT`
  (10) médias Instagram les plus récents. `getInsightsThresholds()` borne
  donc `lowActivityMinPosts` à cette même constante : une valeur configurée
  au-delà de 10 serait structurellement toujours atteinte (jamais assez de
  médias récupérés pour la satisfaire) et déclencherait le signal en
  permanence, à tort. Couvert par un test dédié dans
  `meta-insights-signals.spec.ts` (« Codex review »).
- Mesure uniquement le **nombre de publications réellement horodatées**
  renvoyées par l'API Instagram (`timestamp` du média) — jamais
  d'engagement, de portée ou de croissance inventés. Un média avec un
  horodatage absent ou invalide n'est jamais compté comme récent.
- Couvert par tests (`meta-insights.spec.ts`) : seuil par défaut, seuil
  personnalisé, horodatage invalide, exactement au seuil, au plafond des
  10 médias récupérés ; et (`meta-insights-signals.spec.ts`) : défaut,
  configuration valide, clampage au-delà de 10, configuration invalide.
- Présentée à l'utilisateur comme un seuil configurable, pas comme une
  vérité business — voir `confidence: 'heuristic'` dans le finding.

### Horodatage inconnu ≠ publication ancienne (Codex review)

`countPostsWithinWindow()` distingue deux quantités : le nombre de
publications **confirmées récentes** (horodatage présent, valide, dans la
fenêtre) et le nombre de publications à **horodatage inexploitable**
(absent ou invalide). Un horodatage inexploitable ne prouve pas que la
publication est ancienne — ce n'est qu'une absence de preuve, jamais une
preuve d'absence. `META_LOW_RECENT_ACTIVITY` ne se déclenche donc que si,
même en supposant que **toutes** les publications à horodatage
inexploitable sont en réalité récentes (l'hypothèse la plus favorable),
le total reste sous `lowActivityMinPosts`. Si les publications inconnues
pourraient à elles seules atteindre le seuil, la règle ne se déclenche
pas — l'absence ne serait pas réellement établie. Couvert par des tests
dédiés (`meta-insights.spec.ts`) : horodatage `null` seul, horodatage
invalide seul, mélange horodatage confirmé-ancien + inconnu, et le cas où
la règle se déclenche malgré une incertitude (le pire des cas ne suffit
toujours pas à atteindre un seuil élevé).

### `META_NO_RECENT_MEDIA` vs. échec de lecture

Point explicitement demandé et testé : si la lecture des médias Instagram
échoue (permissions, panne API), `MetaService.getInsightSignals()` renvoie
`recentMedia: { observed: false, items: [] }` — jamais confondu avec
`{ observed: true, items: [] }` (0 média réellement observé). La règle
`META_NO_RECENT_MEDIA` ne se déclenche donc **jamais** sur un échec de
lecture, seulement sur une absence réellement établie.

## Pourquoi ces règles restent hors score SEO

- `evaluateMetaFindings()` ne lit que `MetaAuditSignals` (donnée Meta) —
  aucun accès à `detailed_findings`, `CATEGORY_WEIGHTS` ou
  `compute_seo_score_v2` (tous dans `python-service/`, non touchés par
  cette PR).
- Chaque `MetaFinding` et chaque `Opportunity` Meta porte explicitement
  `scoreInfluence: false`.
- `Opportunity.category` utilise une valeur `'social'`, absente de
  `CATEGORY_WEIGHTS` — même mécanisme d'exclusion que celui déjà en place
  pour `ai_readiness` (RC-25).
- `OpportunitiesService` ne lit jamais `audit.resultJson.seo_score_v2` et
  n'appelle jamais `prisma.audit.update` — prouvé par test
  (`opportunities.service.spec.ts`, describe `Meta opportunities (RC-19)`).

## Pourquoi aucune publication n'est possible

- Aucune permission ajoutée : `MetaService`'s `ALLOWED_READ_SCOPES` /
  `DEFAULT_SCOPES` (RC-18) ne sont pas modifiées par cette PR. Test de
  régression dédié dans `meta-insights-signals.spec.ts` : l'URL
  d'autorisation ne contient jamais `pages_manage_posts` ni
  `instagram_content_publish`.
- `getInsightSignals()` n'effectue que des lectures Graph API (`GET`
  implicite de `graphGet()`) — aucun appel d'écriture n'existe dans
  `MetaService`.
- Une recommandation Meta ne peut devenir qu'une `ActionItem` standard
  (RC-14) : `approvalStatus: 'draft'` par défaut, `executionStatus:
'not_started'`. Aucune exécution automatique n'existe dans le code pour
  quelque opportunité que ce soit (SEO ou Meta) — l'approbation humaine et
  l'exécution restent un chantier futur séparé, non touché ici.

## Absence de fuite de token

`MetaAuditSignals` et `MetaFinding` n'exposent jamais
`encryptedPageAccessToken`/`encryptedUserAccessToken` ni un jeton déchiffré
— seuls des compteurs (`fanCount`, `followersCount`, …), tous nullable, et
des métadonnées de preuve texte. Testé explicitement (`meta-insights-signals.spec.ts`,
« never leaks the decrypted Page access token… ») : le jeton déchiffré
apparaît légitimement dans l'URL sortante vers Meta (paramètre
`access_token`, mécanisme d'auth de Graph API), mais jamais dans la valeur
renvoyée par `getInsightSignals()`.

## Précision sur `META_PROFILE_DATA_INCOMPLETE`

Cette règle observe uniquement que l'API Meta n'a renvoyé ni `fanCount` ni
`followersCount` pour la Page à une lecture donnée. Elle **ne prouve pas**
que le profil Facebook est incomplet ni que sa visibilité publique en est
la cause — l'absence peut aussi venir des permissions accordées à ROBIA,
d'une limitation temporaire de l'API Meta, ou du type de Page. Le titre,
la description et la recommandation reflètent explicitement cette
incertitude (« métriques de profil non retournées », orientation vers une
vérification des permissions Meta plutôt qu'une affirmation de profil
incomplet).

## Revue Codex (post-review, avant re-soumission)

Corrections apportées suite à la revue Codex sur cette PR, avant remise en
revue :

1. Échelle impact/effort Meta normalisée sur 0-10 (voir section dédiée
   ci-dessus) — corrige une incohérence avec le contrat SEO existant.
2. `syncMissingMetaOpportunities()` ajoutée : les opportunités Meta
   manquantes sont désormais insérées même sur un audit déjà généré, sans
   jamais supprimer ni régénérer le SEO existant (voir section dédiée).
3. `MetaService.getInsightsThresholds()` implémentée pour de vrai, avec
   lecture des variables d'environnement documentées et le garde-fou de
   plafonnement à 10 médias (voir section dédiée).
4. Aucune augmentation de la dette ESLint tolérée pour cette fonctionnalité
   — les nouveaux mocks de tests sont précisément typés plutôt que laissés
   en `any`, ce qui a aussi éliminé de la dette préexistante dans les
   mêmes fichiers. Baseline CI (`.github/workflows/backend-ci.yml`)
   corrigée à la valeur mesurée après ces corrections.
5. `META_PROFILE_DATA_INCOMPLETE` reformulée pour ne plus affirmer un
   défaut de profil à partir d'une simple absence de deux compteurs (voir
   section dédiée ci-dessus).

## Revue Codex — second passage

Deux points bloquants supplémentaires, corrigés avant re-soumission :

6. `META_LOW_RECENT_ACTIVITY` ne se déclenche plus sur la seule base
   d'horodatages inconnus qui pourraient, dans le pire des cas, suffire à
   atteindre le seuil configuré — voir « Horodatage inconnu ≠ publication
   ancienne » ci-dessus.
7. `findAllForAudit()` ne peut plus faire disparaître une opportunité
   Meta déjà créée en base derrière 5 opportunités SEO à impact plus
   élevé — voir « Le listing reste source-aware » ci-dessus.

## Ce qui n'est pas fait dans RC19

- Pas de synchronisation Meta en arrière-plan (contrairement à Search
  Console) : `getInsightSignals()` lit Meta en direct, au moment de la
  génération d'opportunités — pas au moment de l'audit.
- Pas de nouvelle table Prisma : les `Opportunity` Meta réutilisent le
  schéma existant.
- Pas de modification de `/integrations/meta/*` (RC-18) : `getPerformance()`,
  le contrôleur, le callback OAuth et `meta.service.spec.ts` sont
  inchangés — évite tout conflit avec le hardening RC-18 en cours sur
  `rc18/hardening-audit`.
- Pas d'action Meta publique, pas de réponse automatique, pas de
  publicité — RC19 ne va pas plus loin que la génération de
  recommandations en `draft`.
