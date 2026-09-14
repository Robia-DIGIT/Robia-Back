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
  `generateFromAudit()`/`generateFromSiteAudit()` appellent désormais aussi
  `generateMetaOpportunities()`, qui convertit chaque `MetaFinding` en
  `Opportunity` (même table que les opportunités SEO, `auditId` obligatoire
  côté schéma Prisma). Additif uniquement : les opportunités SEO existantes
  ne sont ni modifiées ni réordonnées.

## Les 5 règles

Chaque règle ne se déclenche que lorsque l'absence est réellement
observée — jamais par déduction. Toutes portent `source: 'meta'`,
`scoreInfluence: false`, une preuve factuelle (`evidence`), une
recommandation, et un niveau de confiance (`'observed'` = fait constaté
directement, `'heuristic'` = seuil documenté, pas une vérité métier).

| Règle | Condition de déclenchement | Confiance |
|---|---|---|
| `META_PAGE_NOT_SELECTED` | Meta connecté, aucune Page Facebook active sélectionnée | observed |
| `META_INSTAGRAM_NOT_LINKED` | Page sélectionnée, aucun compte Instagram professionnel lié | observed |
| `META_NO_RECENT_MEDIA` | Instagram lié, lecture des médias réussie, 0 média retourné | observed |
| `META_LOW_RECENT_ACTIVITY` | Instagram lié, médias présents, mais moins de N publications sur les M derniers jours (seuil heuristique) | heuristic |
| `META_PROFILE_DATA_INCOMPLETE` | Lecture de la Page réussie, mais `fanCount` ET `followersCount` tous deux `null` | observed |

`META_PAGE_NOT_SELECTED` court-circuite les autres règles : tant qu'aucune
Page n'est choisie, rien d'autre n'est réellement observable — les évaluer
quand même produirait soit un doublon de la même cause racine, soit une
absence fabriquée.

### Heuristique `META_LOW_RECENT_ACTIVITY`

- Seuil : `lowActivityMinPosts` publications sur une fenêtre glissante de
  `lowActivityWindowDays` jours. Défaut documenté (`DEFAULT_META_INSIGHTS_THRESHOLDS`
  dans `meta-insights.ts`) : 30 jours / 1 publication.
- Mesure uniquement le **nombre de publications réellement horodatées**
  renvoyées par l'API Instagram (`timestamp` du média) — jamais
  d'engagement, de portée ou de croissance inventés. Un média avec un
  horodatage absent ou invalide n'est jamais compté comme récent.
- Couvert par tests (`meta-insights.spec.ts`) : seuil par défaut, seuil
  personnalisé, horodatage invalide, exactement au seuil.
- Présentée à l'utilisateur comme un seuil configurable, pas comme une
  vérité business — voir `confidence: 'heuristic'` dans le finding.

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
