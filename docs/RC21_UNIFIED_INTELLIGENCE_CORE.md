# RC21 — Unified Intelligence Core

RC21 introduit un contrat unique que chaque « provider » de signal (SEO,
PageSpeed, Search Console, GA4, Meta, GBP) respecte, pour que
`OpportunitiesService` et tout futur consommateur (Command Center UI, RC-22)
traitent ces sources de manière homogène au lieu de multiplier des branches
`isMeta*` spécifiques par provider (le pattern introduit par RC-19).

**Portée RC21** : architecture additive, zéro régression. Aucun moteur de
score n'est réécrit, aucune donnée n'est fabriquée, aucun appel réseau
supplémentaire n'est ajouté là où une donnée existe déjà.

```
Provider → Normalized Signal → Finding → Opportunity → Action
```

## Contraintes respectées (vérifiées par les tests, voir plus bas)

- `seo_score_v2` (moteur Python, `python-service/app/agents/scoring.py`),
  ses poids, ses règles et son pipeline : **non modifiés**. RC-21 ne fait
  que lire ce score déjà persisté (`SeoIntelligenceAdapter`).
- `Audit.globalScore` (GSC/Meta/GA4/GBP) : **non modifié**. Aucun adaptateur
  ni le registry n'appelle jamais `prisma.audit.update`/`updateMany`.
- Meta reste read-only et `scoreInfluence: false` (inchangé depuis RC-18/19).
- GBP n'a aucune vraie intégration : `GbpIntelligenceAdapter` est un
  placeholder à zéro I/O (zéro dépendance de constructeur, zéro appel
  réseau ou base de données), qui rapporte systématiquement
  `not_connected`.
- Aucune métrique GA4/GBP/Meta n'est fabriquée : une donnée absente devient
  `data: null` + `status`/`unavailableReason` explicites, jamais un zéro
  artificiel.
- RC-14 (SEO) et RC-20 (Ops Automation) ne sont pas régressés (suite
  complète : 318/318 tests passent, aucun fichier RC-14/RC-20 modifié).
- Aucune publication externe, isolation multi-tenant obligatoire sur
  `GET /intelligence/status` et `GET /intelligence/findings`.

## Architecture

### Avant RC21

```
OpportunitiesService
 ├─ evaluateCurrentMetaFindings() → MetaService.getInsightSignals() → evaluateMetaFindings()
 ├─ buildMetaSourceData() / buildMetaOpportunityData() / isMetaSourceData()
 └─ existingMetaRuleCodes() / syncMissingMetaOpportunities()
```

Toute la logique de collecte et de déduplication était câblée directement
sur Meta ; ajouter un second provider (GSC, GA4, PageSpeed, GBP) aurait
signifié dupliquer entièrement ce chemin.

### Après RC21

```
                         ┌── SeoIntelligenceAdapter (lecture seule, seo_score_v2)
                         ├── PageSpeedIntelligenceAdapter (relit resultJson, 0 appel Google)
IntelligenceRegistry ────┼── SearchConsoleIntelligenceAdapter (RC-13, jamais throw)
  (Promise.allSettled)   ├── Ga4IntelligenceAdapter (RC-13 live call, seulement si connecté+configuré)
                         ├── MetaIntelligenceAdapter (RC-18/19, inchangé)
                         └── GbpIntelligenceAdapter (placeholder, 0 I/O)
        │
        ├── getStatus(organizationId)          → GET /intelligence/status
        └── collectFindings(organizationId, ctx) → OpportunitiesService (générique)
```

- `src/intelligence/intelligence.types.ts` — contrats communs :
  `IntelligenceProvider`, `ProviderStatus`, `IntelligenceSignal<T>`,
  `IntelligenceFinding`, `AuditIntelligenceContext`,
  `IntelligenceProviderAdapter`.
- `src/intelligence/intelligence-registry.service.ts` — agrégateur central.
  Isole chaque adaptateur avec `Promise.allSettled` : si un provider lève
  une exception inattendue, il dégrade en `status: 'unavailable'` (pour
  `getStatus`) ou en `[]` findings pour ce provider (pour
  `collectFindings`), **sans jamais empêcher les autres providers de
  répondre**. C'est l'implémentation centralisée de « panne d'un provider :
  les autres fonctionnent ».
- `src/intelligence/adapters/*.ts` — six adaptateurs, chacun une fine
  traduction vers le contrat commun, sans jamais réimplémenter la logique
  métier sous-jacente :
  - `seo-intelligence.adapter.ts` : lit `resultJson.site_audit.seo_score_v2`
    du dernier audit `completed` de l'organisation. Ne calcule ni ne
    recalcule jamais ce score. `collectFindings` retourne toujours `[]` —
    le pipeline SEO (`OpportunityGeneratorService`) reste intact et séparé.
  - `pagespeed-intelligence.adapter.ts` : lit
    `resultJson.site_audit.pagespeed_insights` déjà persisté par le pipeline
    d'audit (RC-10/11). **Aucun second appel** à l'API PageSpeed Insights.
  - `search-console-intelligence.adapter.ts` : appelle telle quelle
    `GoogleSearchConsoleService.getSearchConsoleSignalsForAudit()` (RC-13),
    qui ne fait elle-même aucun appel Google live et ne lève jamais.
  - `ga4-intelligence.adapter.ts` : vérifie d'abord `getStatus()` (lecture
    Prisma pure, aucun réseau) ; n'appelle
    `getAnalyticsPerformance()` (appel live existant, RC-13) que si
    l'organisation est réellement connectée ET a sélectionné une propriété
    Analytics. Un échec du live call dégrade en `unavailable`, jamais en
    donnée fabriquée.
  - `meta-intelligence.adapter.ts` : enveloppe
    `MetaService.getInsightSignals()` + `evaluateMetaFindings()` (RC-18/19)
    sans rien réécrire.
  - `gbp-intelligence.adapter.ts` : placeholder pur — zéro dépendance de
    constructeur, zéro I/O. Rapporte toujours `not_connected`.
- `src/intelligence/latest-audit.util.ts` — utilitaire partagé
  (`findLatestCompletedAudit`) utilisé par les adaptateurs SEO et PageSpeed,
  qui n'ont pas de « snapshot courant » hors d'un audit.
- `src/intelligence/intelligence.controller.ts` — endpoints HTTP org-scoped,
  lecture seule :
  - `GET /intelligence/status` → `IntelligenceRegistryService.getStatus()`.
  - `GET /intelligence/findings?auditId=` → résout l'audit via
    `(id, organizationId)` (404 si l'audit n'appartient pas à l'organisation
    appelante, jamais de fuite d'existence), puis
    `IntelligenceRegistryService.collectFindings()`.
- `src/intelligence/intelligence.module.ts` — module `@Global()`, même
  convention que `IntegrationsModule`/`PrismaModule`.
- `src/opportunities/opportunities.service.ts` — refactorisé pour consommer
  `IntelligenceRegistryService` au lieu de `MetaService` directement :
  - `buildMetaSourceData`/`buildMetaOpportunityData`/`isMetaSourceData`/
    `existingMetaRuleCodes`/`syncMissingMetaOpportunities` deviennent
    génériques (`buildProviderSourceData`, etc.), pilotés par
    `IntelligenceFinding` au lieu de `MetaFinding`.
  - `sourceData` passe de `version: 1` à `version: 2` et gagne un champ
    `provider` — mais **conserve** l'ancien champ `source` avec la même
    valeur, donc les opportunités Meta déjà persistées avant RC-21 (qui
    n'ont que `source`) restent reconnues sans migration ni backfill
    (`isProviderSourceData` lit l'un ou l'autre champ).
  - La clé de déduplication passe de `ruleCode` seul à
    `${provider}:${ruleCode}`, pour qu'aucune collision ne soit possible
    entre deux providers qui réutiliseraient la même chaîne de règle.
  - `findAllForAudit` garde le top-5 SEO inchangé et ajoute systématiquement
    à côté toutes les opportunités provider de l'audit (comportement RC-19
    généralisé, pas modifié).

## Contrat `sourceData` versionné

Chaque opportunité provider (`buildProviderSourceData`) persiste au minimum :

```json
{
  "version": 2,
  "provider": "meta",
  "source": "meta",
  "ruleCode": "META_INSTAGRAM_NOT_LINKED",
  "confidence": "observed",
  "evidence": [...],
  "recommendation": "...",
  "scoreInfluence": false
}
```

> **Revue Codex (round 1).** `confidence` (`'observed' | 'heuristic'`,
> RC-19's `MetaFinding.confidence`, lu par le frontend pour distinguer un
> constat direct d'un seuil documenté) avait été omis de la première
> version de `buildProviderSourceData()`. Corrigé : `IntelligenceFinding`
> gagne un champ `confidence` optionnel (`IntelligenceFindingConfidence`),
> `MetaIntelligenceAdapter` le mappe depuis `MetaFinding.confidence`, et
> `buildProviderSourceData()` le persiste — jamais fabriqué pour un
> provider qui ne le distingue pas. Voir le test « preserves MetaFinding's
> 'observed' vs 'heuristic' confidence... » dans
> `opportunities.service.spec.ts`.

## Preuve que `seo_score_v2` n'a pas changé

`src/intelligence/seo-score-invariance.spec.ts` fait tourner le pipeline
**réel** (registry + les 6 vrais adaptateurs + `MetaService` +
`GoogleSearchConsoleService`, seul Prisma et les couches HTTP externes sont
mockées — rien n'est mocké au niveau d'`OpportunitiesService`) sur un
fixture `seo_score_v2` gelé (`Object.freeze`), et vérifie :

1. `prisma.audit.update`/`updateMany` sont volontairement laissés `undefined`
   (pas un mock) — si quoi que ce soit dans le pipeline tentait d'écrire
   l'audit, le test échouerait avec « not a function » plutôt que de
   réussir silencieusement.
2. Le fixture `seoScoreV2` reste `toEqual` byte-for-byte identique après le
   passage dans `generateFromAudit()`.
3. Aucune opportunité générée n'embarque un score muté.

## Comportement de chaque provider lorsqu'il est indisponible

| Provider | Non connecté | Connecté mais non configuré | Erreur transitoire | Donnée absente/legacy |
|---|---|---|---|---|
| SEO | — | — | `unavailable` (`no_audit`) | `partial` (`legacy_audit_result`), jamais un score inventé |
| PageSpeed | — | — | `unavailable` (`no_pagespeed_data`/`no_audit`) | `data: null` |
| Search Console | `not_connected` | `not_configured` (`no_property_selected`) | `unavailable` | `data: null` |
| GA4 | `not_connected` (aucun appel live) | `not_configured` (`analytics_scope_not_granted`/`no_property_selected`, aucun appel live) | `unavailable` (`temporarily_unavailable`) | `data: null` |
| Meta | `not_connected` | `not_configured` | `unavailable` | `data: null` |
| GBP | `not_connected` (toujours — pas d'intégration réelle en RC-21) | — | — | `data: null`, zéro appel réseau par construction |

Dans tous les cas : `data` reste `null` quand `status` n'est ni `ok` ni
`partial` — jamais de valeur zéro synthétique.

## Fichiers créés

```
src/intelligence/intelligence.types.ts
src/intelligence/intelligence-registry.service.ts
src/intelligence/intelligence-registry.service.spec.ts
src/intelligence/intelligence.controller.ts
src/intelligence/intelligence.controller.spec.ts
src/intelligence/intelligence.module.ts
src/intelligence/latest-audit.util.ts
src/intelligence/seo-score-invariance.spec.ts
src/intelligence/adapters/seo-intelligence.adapter.ts (+ .spec.ts)
src/intelligence/adapters/pagespeed-intelligence.adapter.ts (+ .spec.ts)
src/intelligence/adapters/search-console-intelligence.adapter.ts (+ .spec.ts)
src/intelligence/adapters/ga4-intelligence.adapter.ts (+ .spec.ts)
src/intelligence/adapters/meta-intelligence.adapter.ts (+ .spec.ts)
src/intelligence/adapters/gbp-intelligence.adapter.ts (+ .spec.ts)
```

## Fichiers modifiés

```
src/app.module.ts                               (+2, enregistrement d'IntelligenceModule)
src/opportunities/opportunities.service.ts      (refactor générique, voir plus haut)
src/opportunities/opportunities.service.spec.ts (adapté au nouveau mock IntelligenceRegistryService)
src/multi-tenant-isolation.spec.ts              (+ test négatif multi-tenant pour /intelligence/findings)
src/organization-isolation.spec.ts              (type swap MetaService → IntelligenceRegistryService)
```

Aucune migration Prisma : tout l'état RC-21 est calculé à la lecture, sauf
les opportunités provider qui réutilisent le champ `Opportunity.sourceData`
(Json) déjà existant depuis RC-19.

## Tests exécutés

```
npx jest --silent   → 51 suites, 318 tests, tous passants
npx tsc --noEmit -p tsconfig.json   → aucune nouvelle erreur (une erreur de
  type pré-existante et sans rapport avec RC-21 subsiste dans
  src/integrations/n8n-webhook.service.spec.ts, fichier non touché par RC-21)
npx eslint <fichiers RC-21>   → 0 erreur (seuls des warnings pré-existants,
  non liés à RC-21, subsistent dans organization-isolation.spec.ts)
npm run build   → prisma generate + nest build : succès
```

Couverture des exigences de tests obligatoires de l'issue #41 :

- Fixture SEO : `seo_score_v2` strictement identique avant/après →
  `seo-score-invariance.spec.ts`.
- Meta/GSC/GA4/GBP ne font aucun `audit.update` →
  `seo-score-invariance.spec.ts` (update/updateMany volontairement non
  mockés).
- Meta non connecté : pas de fausse métrique →
  `meta-intelligence.adapter.spec.ts`.
- GBP absent : aucun appel réseau →
  `gbp-intelligence.adapter.spec.ts` (`GbpIntelligenceAdapter.length === 0`).
- Panne d'un provider : les autres fonctionnent →
  `intelligence-registry.service.spec.ts` (isolation `getStatus`/
  `collectFindings`), reflété aussi dans
  `opportunities.service.spec.ts`.
- Null reste null → chaque adapter spec vérifie `data: null` sur les
  statuts non-`ok`/`partial`.
- Déduplication provider + ruleCode →
  `opportunities.service.spec.ts` (clé composite `${provider}:${ruleCode}`).
- Régénération additive préserve l'existant →
  `opportunities.service.spec.ts` (« Provider opportunities (RC-21,
  generalizes RC-19 Meta) »).
- Isolation multi-tenant négative →
  `multi-tenant-isolation.spec.ts` + `intelligence.controller.spec.ts`.
- RC-14/RC-20 non régressifs → suite complète 318/318, aucun fichier RC-14/
  RC-20 modifié.
