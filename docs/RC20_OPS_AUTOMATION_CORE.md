# RC20 — ROBIA Ops Automation Core

RC20 construit le moteur générique d'automatisation de ROBIA : la fondation
technique permettant d'automatiser, de manière sûre, traçable et
multi-tenant, des tâches répétitives internes à ROBIA. Ce n'est ni un
chatbot ni un dashboard admin — c'est un moteur d'exécution avec
gouvernance intégrée (conditions déterministes, approbation humaine,
allowlist d'actions, historique append-only).

**Portée RC20** : uniquement des actions ROBIA internes et sûres (audit,
opportunités, rapport, tâche interne). Aucun workflow autonome sensible
n'agit sur un service externe. Le scheduler est préparé dans le modèle de
données (`AutomationTrigger.type === 'scheduled'`) mais **rien ne
l'exécute encore** — voir « Ce qui n'est pas fait » plus bas.

> **Round 2 (revue Codex).** Codex a identifié 5 problèmes bloquants sur la
> première version de ce PR : `dedupKey` d'événement non scopé par
> automation, approbation non liée à un plan d'exécution immuable,
> transition approve/reject non atomique, garantie « un seul run actif »
> non imposée en base, et champs non allowlistés persistables dans les
> inputs de step / payloads d'événement. Les cinq sont corrigés — voir les
> sections « Modèle d'idempotence », « Garde-fous » et « Tests »
> ci-dessous, qui reflètent l'état corrigé.
>
> **Round 3 (re-revue Codex).** Deux problèmes bloquants supplémentaires,
> découverts après le round 2 : (1) `plannedSteps` était figé **avant**
> résolution des `{{event.<key>}}`, donc un approbateur voyait le
> placeholder brut plutôt que la valeur réellement exécutée ; (2)
> `AutomationEvent` était unique sur `(organizationId, eventKey)` seul —
> réutiliser la même `eventKey` sous un `eventType` différent pouvait
> renvoyer silencieusement le mauvais événement (et son payload) à une
> automation qui n'avait rien à voir. Les deux sont corrigés : la résolution
> des templates se fait maintenant au déclenchement (le plan stocké est déjà
> la valeur finale), et l'unicité de `AutomationEvent` est désormais scopée
> par `(organizationId, eventType, eventKey)`.

## Architecture

```
Trigger → Rule/Condition → Workflow (steps) → Approval (éventuelle) → Execution → Evidence → History
```

- **`Automation`** (`prisma/schema.prisma`) — la définition : nom,
  description, `enabled`, organisation, `conditions` (arbre JSON),
  `steps` (liste ordonnée `{ actionType, input? }`), `requiresApproval`,
  `createdById`, `lastRunAt`/`nextRunAt`, `metadata` non sensible,
  timestamps.
- **`AutomationTrigger`** — un par automation (`type: manual | scheduled |
event`, `cronExpression?`, `eventType?`).
- **`AutomationEvent`** — le « système d'événements » : un événement
  entrant (`eventType`, `eventKey`, `payload`), dédupliqué par
  `(organizationId, eventKey)` avant même d'être comparé à une
  automation.
- **`AutomationRun`** — une exécution : `status`, `triggerType`,
  `dedupKey` (unique par organisation), `sourceEventId`, champs
  d'approbation, `context` (snapshot des conditions évaluées, redacted),
  `plannedSteps` (snapshot immuable des steps — action + input canonique —
  figé au déclenchement, voir « Modèle d'idempotence »), `errorMessage`
  (redacted).
- **`AutomationStepRun`** — un step exécuté : `sequence`, `actionType`,
  `input` (résolu), `status`, `evidence` (redacted), `error` (redacted),
  timestamps.

Code :

- `src/ops-automation/condition-engine.ts` — moteur de conditions pur.
- `src/ops-automation/automation-context.service.ts` — construit le
  contexte d'évaluation (lecture seule, par organisation).
- `src/ops-automation/actions/ops-actions-registry.service.ts` —
  l'allowlist d'actions.
- `src/ops-automation/automation-templating.ts` — résolution
  `{{event.<key>}}` dans les inputs de step.
- `src/ops-automation/automations.service.ts` — le moteur d'exécution et
  toute la logique CRUD/approbation/idempotence.
- `src/ops-automation/automations.controller.ts` — l'API HTTP.
- `src/ops-automation/examples/automation-examples.ts` — les 3 exemples
  de démonstration (désactivés).

## État machine

```
                 ┌──────────┐
   trigger  ───► │  queued  │
                 └────┬─────┘
                      │ (évaluation conditions, quasi instantanée — RC20
                      │  exécute de façon synchrone, pas de file d'attente)
        ┌─────────────┼──────────────────┬─────────────────┐
        ▼             ▼                  ▼                 ▼
   ┌─────────┐  ┌───────────┐      ┌───────────┐     (disabled ou
   │ skipped │  │  running  │      │ waiting_  │      dedup existant)
   └─────────┘  └─────┬─────┘      │ approval  │
  (conditions          │           └─────┬─────┘
   fausses, ou          │ (steps séquentiels)   │ approve        │ reject
   automation           ▼                       ▼                ▼
   désactivée)    ┌───────────┐┌──────────┐ running        cancelled
                  │ succeeded ││  failed  │
                  └───────────┘└──────────┘
```

- `queued` : créé, en cours d'évaluation (transitoire).
- `running` : les steps s'exécutent séquentiellement.
- `waiting_approval` : conditions vraies, `requiresApproval: true` —
  aucun step n'existe encore tant que le run n'est pas approuvé.
- `succeeded` / `failed` : tous les steps ont réussi / un step a échoué
  (arrêt immédiat, les steps suivants ne sont jamais exécutés).
- `cancelled` : run rejeté — **aucun step n'est jamais créé** pour un run
  rejeté.
- `skipped` : conditions fausses, ou automation désactivée au moment du
  déclenchement.

Chaque `AutomationStepRun` a son propre cycle : `queued → running →
succeeded | failed` (ou directement `failed` si son `actionType` n'est
pas allowlisté).

## Modèle d'idempotence

Deux niveaux, tous deux imposés par une contrainte unique en base
(`@@unique`), jamais seulement en mémoire :

1. **Événement** — `AutomationEvent` est unique par
   `(organizationId, eventType, eventKey)` — scopé par type, pas seulement
   par clé : une `eventKey` n'est garantie unique qu'au sein de son propre
   `eventType` (deux types d'événements différents peuvent coïncidentellement
   utiliser la même chaîne de clé). Réutiliser la même `eventKey` sous un
   `eventType` différent crée donc une **nouvelle** ligne au lieu de
   renvoyer par erreur celle d'un autre type avec son payload (bug identifié
   en re-revue Codex, corrigé). Émettre le même événement deux fois (même
   `eventType` **et** même `eventKey`) renvoie la ligne déjà existante ;
   aucune deuxième ligne n'est créée.
2. **Run** — `AutomationRun` est unique par `(organizationId,
dedupKey)`. Pour un déclenchement événementiel, `dedupKey =
automation:<automationId>:event:<eventId>` — scopé par automation, pas
   seulement par événement : si plusieurs automations correspondent au même
   événement, chacune obtient son propre run indépendamment dédupliqué,
   au lieu qu'une seconde automation ne « récupère » par erreur le run de
   la première (bug identifié en revue Codex, corrigé). Pour un
   déclenchement manuel, `dedupKey` est un UUID frais à chaque appel : un
   clic manuel est une action volontaire et distincte, jamais un doublon à
   dédupliquer.

`AutomationsService.startRun()` vérifie d'abord l'existence d'un run pour
ce `dedupKey` **avant** toute autre logique (avant même de vérifier si
l'automation est activée) : un doublon renvoie systématiquement le run
déjà décidé, jamais un nouveau résultat. Une course (deux requêtes
concurrentes avec le même `dedupKey`) est absorbée en récupérant la ligne
créée par l'autre requête après une violation de contrainte unique
(`P2002`), jamais par un verrou applicatif.

### Snapshot immuable du plan d'exécution

`startRun()` fige, au moment du déclenchement, un `plannedSteps` :
chaque step avec son `actionType` et son input **canonique, déjà résolu**
(voir « Entrées canoniques allowlistées » ci-dessous), calculé une seule
fois et stocké sur le run lui-même. `executeSteps()` exécute **toujours**
`run.plannedSteps` tel quel — jamais `automation.steps`, et sans jamais
re-résoudre quoi que ce soit — donc éditer une automation pendant qu'un de
ses runs attend une approbation (`waiting_approval`) ne change jamais ce
que l'approbateur exécute réellement en cliquant « approuver ». C'est la
correction du deuxième problème bloquant identifié en revue Codex : avant
ce correctif, `approveRun()` relisait l'automation courante (potentiellement
déjà modifiée), rompant le lien entre ce qui avait été revu et ce qui
s'exécutait.

Un point capital, corrigé en re-revue Codex : la résolution d'un
placeholder `{{event.<key>}}` (voir `automation-templating.ts`) se fait
**au déclenchement**, contre le payload déjà persisté (et redacted) de
l'événement — pas à l'exécution. `plannedSteps` contient donc la **valeur
littérale finale** (`"audit-123"`), jamais le template brut
(`"{{event.auditId}}"`). Sans ça, un `waiting_approval.plannedSteps`
affichait le placeholder non résolu : l'approbateur voyait un plan
« immuable » qui ne révélait pourtant pas la valeur réelle qui allait
s'exécuter — la structure était figée, mais pas la valeur visible. Si la
résolution échoue (placeholder sans valeur disponible — typiquement une
automation déclenchée manuellement alors que ses steps attendent un
événement), le run passe directement à `failed` avec un message clair,
sans jamais créer de step ni appeler `executeSteps()`.

### Transitions approve/reject atomiques

`approveRun()`/`rejectRun()` ne font plus un `read` puis un `update`
inconditionnel (une course entre deux appels concurrents pouvait upstream
faire exécuter deux fois les mêmes steps, ou exécuter un run pourtant déjà
rejeté). La transition réelle est un `updateMany` conditionnel — `WHERE
status = 'waiting_approval' AND approvalStatus = 'pending'` — dont le
résultat (`count`) dit si CET appel a gagné la course ; en Postgres, deux
`UPDATE` concurrents sur la même ligne se sérialisent, donc au plus un des
deux peut jamais matcher. Le `getRun()` initial ne sert plus qu'au
contrôle d'accès organisation et au message d'erreur ; il ne décide plus
rien.

### Un seul run actif — imposé en base, pas seulement vérifié en amont

Un index unique partiel (`automation_runs_one_active_per_automation`, voir
la migration `20260914175102_rc20_snapshot_and_concurrency_guards`) sur
`automation_runs(automation_id) WHERE status IN ('queued', 'running',
'waiting_approval')` empêche physiquement deux runs actifs simultanés pour
la même automation — y compris sous deux déclenchements manuels vraiment
concurrents (deux `dedupKey` différents, donc le dédup par `dedupKey` seul
ne les aurait pas arrêtés). Le `findFirst` dans `startRun()` reste un
échec rapide et convivial (message clair sans attendre une violation de
contrainte), mais la garantie réelle est cet index : `persistRun()`
distingue un `P2002` dû au `dedupKey` (course d'idempotence, ligne
existante renvoyée) d'un `P2002` dû à cet index (`AutomationRunConflictError`).

### Entrées canoniques allowlistées

Chaque action du registre déclare son propre `inputSchema` — la liste
exhaustive des clés qu'elle lit jamais rien d'autre. `OpsActionsRegistryService.
canonicalizeInput(actionType, input)` valide les champs requis puis
retourne un **nouvel objet** ne contenant que ces clés : tout champ
supplémentaire (un `token`/`apiKey` collé au mauvais endroit, un flag de
debug oublié) est éliminé, jamais copié. `AutomationsService` appelle ce
choke point à deux moments :

1. À la création/modification d'une automation (`validateSteps()`) — donc
   `Automation.steps` en base ne peut déjà contenir que les clés
   allowlistées, quel que soit ce que le client a envoyé.
2. Au déclenchement (`startRun()`, au moment de figer `plannedSteps`) — une
   seconde passe, défensive, avant que quoi que ce soit ne soit persisté
   dans `AutomationRun.plannedSteps` ou exécuté.

Le payload d'un `AutomationEvent` (fourni par l'émetteur de l'événement,
pas par l'utilisateur qui définit l'automation) passe par
`redactSensitive()` (RC-15) avant d'être écrit — même garantie que pour
`context`/`evidence`/`errorMessage`, appliquée ici pour la première fois
à ce nouveau point d'entrée (corrige le cinquième problème bloquant
identifié en revue Codex).

## Garde-fous

| Garde-fou               | Mécanisme                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentification        | `JwtAuthGuard` sur tout le contrôleur                                                                                                                                                                                                       |
| Scope organisation      | `OrgScopeGuard` dérive `organizationId` du token — jamais du body/params client                                                                                                                                                             |
| RBAC                    | Voir « RBAC — état actuel » ci-dessous                                                                                                                                                                                                      |
| Cross-tenant            | Chaque requête Prisma filtre par `organizationId` ; `findOne`/`getRun` renvoient `NotFoundException` (jamais `Forbidden`, pour ne pas révéler l'existence d'une ressource d'une autre organisation)                                         |
| Fuite de secret         | `redactSensitive()` (RC-15) appliqué à `context`, `evidence`, `error`, `errorMessage` avant toute écriture en base                                                                                                                          |
| Erreurs                 | Le filtre global (`AllExceptionsFilter`) redacte déjà toute erreur 5xx ; en plus, RC-20 ne persiste jamais un message d'erreur brut (toujours passé par `redactSensitive`)                                                                  |
| Concurrence             | Un seul run actif (`queued`/`running`/`waiting_approval`) par automation à la fois, **imposé par un index unique partiel en base** (`automation_runs_one_active_per_automation`) — pas seulement un pré-contrôle applicatif — `AutomationRunConflictError` sinon |
| Boucle d'automatisation | `MAX_TRIGGER_DEPTH` (3) sur le paramètre interne `triggerDepth` de `startRun()` — non atteignable aujourd'hui (aucune action n'émet encore d'événement), mais posé pour ne jamais permettre une chaîne de déclenchement qui s'auto-alimente |
| Nombre de steps         | `MAX_STEPS_PER_AUTOMATION` (20), vérifié à la création **et** à l'exécution (défense en profondeur)                                                                                                                                         |
| Action arbitraire       | Voir « Catalogue d'actions autorisées » — toute chaîne non enregistrée est rejetée à la création (`AutomationValidationError`) et, en défense en profondeur, à l'exécution                                                                  |
| Entrée de step non allowlistée | `canonicalizeInput()` — voir « Entrées canoniques allowlistées » — ne laisse jamais un champ hors schéma atteindre le stockage ou l'exécution                                                                                       |
| Condition dynamique     | Aucun `eval`/`Function` — voir `condition-engine.ts`                                                                                                                                                                                        |
| Approbation liée à un plan figé | `plannedSteps` — voir « Snapshot immuable du plan d'exécution » — un edit après déclenchement ne change jamais ce qu'exécute une approbation                                                                                        |
| Transition approve/reject | `updateMany` conditionnel (compare-and-swap) — voir « Transitions approve/reject atomiques » — jamais un `read` puis `update` inconditionnel                                                                                             |

### RBAC — état actuel

Le modèle ROBIA actuel n'a pas encore de rôles multi-utilisateurs par
organisation (`Organization.ownerId` est le seul lien vers un `User`).
RC-20 s'aligne donc sur ce qui existe déjà : toute action (créer, activer,
lancer, approuver, rejeter) requiert d'être authentifié et scopé sur
l'organisation via `OrgScopeGuard`, exactement comme le reste de l'API.
Il n'y a pas de rôle « approbateur » distinct du propriétaire de
l'organisation aujourd'hui. Le modèle de données (`AutomationRun.
approvedById`, `triggeredById`) enregistre déjà **qui** a déclenché et
qui a approuvé/rejeté — la donnée est prête pour un futur RBAC plus fin
sans migration supplémentaire.

### Séparation des scopes (préparée, non construite)

`Automation.scope` vaut aujourd'hui toujours `'ORGANIZATION'` (une PME
automatisant ses propres opérations) — la seule valeur utilisée par RC20.
Une seconde valeur, `'ROBIA_INTERNAL'` (ROBIA opérant sur ROBIA
lui-même), est déjà un choix valide dans la colonne mais rien ne
l'utilise encore. `'PARTNER'`, `'PROGRAM'`, `'COHORT'` (Orange Digital
Center, Orange Formation, cohortes de formation) ne sont **pas**
construits dans RC20 — mais la colonne `scope` (String, pas un enum
fermé) et l'absence de toute logique qui suppose `scope ===
'ORGANIZATION'` ailleurs que dans la validation actuelle signifient
qu'ajouter ces scopes plus tard n'exige aucune migration destructive,
seulement une extension du champ `scope` et des règles d'accès associées.

## Catalogue d'actions autorisées

L'allowlist (`OpsActionsRegistryService`) — la **seule** liste qu'une
`Automation.steps[].actionType` peut référencer :

| `actionType`                                | Effet                                                                                                                                        | Entrée          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `robia.audit.run_diagnostic`                | Lance un audit sur un site déjà connecté à l'organisation (délègue à `AuditsService.run`, RC-10/RC-13)                                       | `{ websiteId }` |
| `robia.opportunities.regenerate`            | Génère/complète les opportunités (SEO + Meta) pour un audit terminé (délègue à `OpportunitiesService.generateFromAudit`, RC-19 — idempotent) | `{ auditId }`   |
| `robia.report.prepare_organization_summary` | Lecture seule : sites, dernier audit, opportunités ouvertes, tâches en attente                                                               | _(aucune)_      |
| `robia.action_items.create_internal_task`   | Crée un `ActionItem` en `draft`/`not_started` (RC-14) — jamais approuvé ni exécuté automatiquement                                           | `{ title }`     |

**Explicitement exclu, pour toujours** : shell arbitraire, SQL arbitraire,
appel HTTP/URL arbitraire, merge GitHub, déploiement, suppression
destructive, publication Meta/GBP. Aucune de ces actions n'existe dans le
registre — les ajouter demanderait une revue de sécurité dédiée, pas une
simple entrée de configuration.

## Threat model (court)

| Menace                                                                                           | Mitigation                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Un client falsifie `organizationId` pour lire/modifier une autre organisation                    | `OrgScopeGuard` dérive `organizationId` du JWT, jamais du body/params — chaque requête Prisma re-filtre dessus                                                                             |
| Un `Automation.steps` référence une action dangereuse                                            | Allowlist stricte, validée à la création et à l'exécution                                                                                                                                  |
| Un attaquant tente d'injecter du code via `conditions`                                           | Pas d'`eval` : arbre JSON strictement typé, champs/opérateurs allowlistés (`condition-engine.ts`)                                                                                          |
| Un secret (token Meta/GSC, etc.) fuit dans l'historique d'un run                                 | Le contexte de conditions ne contient que des compteurs/statuts (jamais un token) ; `evidence`/`error`/`context` passent systématiquement par `redactSensitive()` avant écriture           |
| Un événement dupliqué (retry réseau, double webhook) déclenche deux fois la même action sensible | Double dédup (événement, puis run) sur contrainte unique en base                                                                                                                           |
| Une automation en boucle sature le système                                                       | `MAX_TRIGGER_DEPTH`, `MAX_STEPS_PER_AUTOMATION`, un seul run actif par automation                                                                                                          |
| Une action non approuvée s'exécute quand même                                                    | `requiresApproval: true` bloque la création de tout `AutomationStepRun` tant que `approveRun()` n'a pas été appelé ; `rejectRun()` marque `cancelled` sans jamais appeler `executeSteps()` |
| Une automation désactivée s'exécute quand même                                                   | `startRun()` vérifie `automation.enabled` avant toute évaluation de conditions et avant tout step                                                                                          |
| Deux automations partagent par erreur le run d'un même événement (une automation « vole » le résultat d'une autre) | `dedupKey` d'un run déclenché par événement inclut `automationId` — chaque automation obtient son propre run, dédupliqué indépendamment                                                   |
| Une automation est modifiée pendant qu'un run attend une approbation, et l'approbateur exécute sans le savoir des actions différentes de celles revues | `plannedSteps` fige le plan (action + input canonique) au déclenchement ; `executeSteps()` n'exécute jamais que ce snapshot                                                                |
| Deux requêtes concurrentes (approve+approve, approve+reject) exécutent deux fois les mêmes steps, ou exécutent un run déjà rejeté | Transition `updateMany` conditionnelle (compare-and-swap) — une seule des deux peut jamais matcher la ligne                                                                                |
| Un champ hors-schéma (secret collé au mauvais endroit) est stocké dans un input de step ou un payload d'événement | `canonicalizeInput()` (steps) et `redactSensitive()` (payload d'événement) avant toute persistance                                                                                         |
| Un approbateur voit un placeholder `{{event.*}}` non résolu au lieu de la valeur réelle qui va s'exécuter | Résolution au déclenchement (pas à l'exécution) contre le payload déjà persisté de l'événement ; `plannedSteps` stocke la valeur finale, jamais le template                              |
| Réutiliser la même `eventKey` sous un `eventType` différent déclenche des automations d'un type avec le payload d'un autre type | `AutomationEvent` unique sur `(organizationId, eventType, eventKey)`, pas seulement `eventKey`                                                                                            |

## Ce qui n'est pas fait dans RC20

- **Aucune exécution planifiée réelle.** `AutomationTrigger.type ===
'scheduled'` et `cronExpression` sont acceptés et stockés, mais aucun
  job/`@nestjs/schedule`/cron ne lit cette configuration pour déclencher
  quoi que ce soit. Un déclenchement `scheduled` reste possible
  uniquement via le même chemin interne que `manual`/`event` (pas encore
  câblé à un scheduler).
- **Aucune émission d'événement automatique.** `AutomationsService.
emitEvent()` existe et fonctionne, mais rien dans `AuditsService`,
  `MetaService`, `GoogleSearchConsoleService` ou ailleurs ne l'appelle.
  Les événements `audit.completed` / `integration.disconnected` utilisés
  par les exemples de démonstration doivent être émis explicitement (par
  un futur RC, ou manuellement en test) — RC20 ne modifie aucun de ces
  modules existants.
- **Pas de retry automatique.** Un step qui échoue arrête le run
  (`failed`) ; relancer est un nouveau déclenchement manuel (donc un
  nouveau `dedupKey`), pas une reprise automatique avec backoff. Ce choix
  est délibéré pour RC20 (complexité/risque non justifiés à ce stade) —
  documenté ici plutôt qu'implémenté à moitié.
- **Pas d'éditeur visuel.** Création/édition se fait via un formulaire
  structuré (frontend) et une API JSON — pas de canvas façon Zapier.
- **Orange Digital Center / Orange Formation.** Aucun scope `PARTNER`,
  `PROGRAM` ou `COHORT`, aucune notion de programme/cohorte. `scope` est
  un champ texte libre déjà prêt à accueillir ces valeurs plus tard.

## Compatibilité avec les modules existants

RC20 ne modifie **aucun fichier** de `python-service/`, de
`seo_score_v2`, de `RC18`/`RC19` (Meta), ou du cycle
draft/approval/execution de RC-14 (`ActionItem`). Les seuls points de
contact :

- `robia.audit.run_diagnostic` appelle `AuditsService.run()` — la même
  méthode déjà utilisée par `AuditsController`, sans modification.
- `robia.opportunities.regenerate` appelle `OpportunitiesService.
generateFromAudit()` — idem, RC-19 déjà testé indépendamment.
- `robia.action_items.create_internal_task` crée un `ActionItem` via
  Prisma directement (pas via `ActionItemsService`, pour zéro risque de
  collision avec ce module), en utilisant les valeurs par défaut du
  schéma (`status: 'todo'`, `approvalStatus: 'draft'`,
  `executionStatus: 'not_started'`) — aucun champ RC-14 n'est modifié.

Deux éléments de drift de schéma **pré-existants**, sans rapport avec
RC20, ont été rencontrés lors de la génération de la migration
(`prisma migrate dev --create-only`) et **délibérément laissés en
dehors** de la migration RC20 (voir le commentaire en tête de
`prisma/migrations/20260914164711_add_ops_automation_core/migration.sql`) :
un défaut de colonne obsolète sur `action_items.updated_at` (RC-14) et une
contrainte `NOT NULL` obsolète sur `users.name` (RC-16). Aucun des deux
n'est corrigé ici — un futur RC dédié au nettoyage de schéma s'en
chargera.

## Tests

- `condition-engine.spec.ts` — validation et évaluation, y compris le
  typage des éléments d'un tableau `in`/`notIn` (22 tests).
- `actions/ops-actions-registry.service.spec.ts` — chaque action, rejet
  des actions non allowlistées, et `canonicalizeInput()` (strip d'un
  champ hors schéma, action sans champ requis, action non allowlistée,
  placeholder templaté jamais rejeté) (21 tests).
- `automation-templating.spec.ts` — résolution `{{event.*}}` (7 tests).
- `automations.service.spec.ts` — isolation organisation, accès non
  autorisé, conditions vrai/faux, idempotence (événement dupliqué **et**
  plusieurs automations sur le même événement, chacune avec son propre
  run), automation désactivée, échec de step, cycle d'approbation complet
  (attente / approbation / rejet / aucune exécution après rejet),
  concurrence (un seul run actif y compris sous deux déclenchements
  manuels réellement concurrents via `Promise.allSettled`), transitions
  approve/reject atomiques (approve+reject concurrents, deux approve
  concurrents — un seul gagne, jamais une double exécution), snapshot de
  plan immuable (edit après déclenchement, l'approbation exécute
  l'original), valeur `{{event.*}}` résolue — pas le placeholder brut —
  visible dans `plannedSteps` avant approbation, échec propre d'un
  placeholder non résolvable (déclenchement manuel sans événement source),
  collision `eventKey` entre deux `eventType` différents (chaque type
  garde son propre événement et son propre payload), boucle interdite,
  secrets jamais persistés (input de step, payload d'événement),
  historique append-only (38 tests).
- `examples/automation-examples.spec.ts` — les 3 exemples restent valides
  contre le moteur réel (7 tests).

Chaque test de concurrence a été vérifié comme réellement discriminant en
retirant temporairement le correctif correspondant et en confirmant que le
test échoue alors de la façon attendue (double exécution / double run actif),
avant de restaurer le correctif.

**NO MERGE. NO DEPLOY.** En attente de revue Codex puis d'autorisation
explicite Romeo/Landry.
