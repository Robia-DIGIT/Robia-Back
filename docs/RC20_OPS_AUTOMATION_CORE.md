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
  `errorMessage` (redacted).
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
   `(organizationId, eventKey)`. Émettre le même événement deux fois
   (même `eventKey`) renvoie la ligne déjà existante ; aucune deuxième
   ligne n'est créée.
2. **Run** — `AutomationRun` est unique par `(organizationId,
dedupKey)`. Pour un déclenchement événementiel, `dedupKey =
event:<eventId>` — donc le même événement ne peut jamais produire
   deux runs pour la même automation, même si `emitEvent()` est rappelé
   plusieurs fois. Pour un déclenchement manuel, `dedupKey` est un UUID
   frais à chaque appel : un clic manuel est une action volontaire et
   distincte, jamais un doublon à dédupliquer.

`AutomationsService.startRun()` vérifie d'abord l'existence d'un run pour
ce `dedupKey` **avant** toute autre logique (avant même de vérifier si
l'automation est activée) : un doublon renvoie systématiquement le run
déjà décidé, jamais un nouveau résultat. Une course (deux requêtes
concurrentes avec le même `dedupKey`) est absorbée en récupérant la ligne
créée par l'autre requête après une violation de contrainte unique
(`P2002`), jamais par un verrou applicatif.

## Garde-fous

| Garde-fou               | Mécanisme                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentification        | `JwtAuthGuard` sur tout le contrôleur                                                                                                                                                                                                       |
| Scope organisation      | `OrgScopeGuard` dérive `organizationId` du token — jamais du body/params client                                                                                                                                                             |
| RBAC                    | Voir « RBAC — état actuel » ci-dessous                                                                                                                                                                                                      |
| Cross-tenant            | Chaque requête Prisma filtre par `organizationId` ; `findOne`/`getRun` renvoient `NotFoundException` (jamais `Forbidden`, pour ne pas révéler l'existence d'une ressource d'une autre organisation)                                         |
| Fuite de secret         | `redactSensitive()` (RC-15) appliqué à `context`, `evidence`, `error`, `errorMessage` avant toute écriture en base                                                                                                                          |
| Erreurs                 | Le filtre global (`AllExceptionsFilter`) redacte déjà toute erreur 5xx ; en plus, RC-20 ne persiste jamais un message d'erreur brut (toujours passé par `redactSensitive`)                                                                  |
| Concurrence             | Un seul run actif (`queued`/`running`/`waiting_approval`) par automation à la fois — `AutomationRunConflictError` sinon                                                                                                                     |
| Boucle d'automatisation | `MAX_TRIGGER_DEPTH` (3) sur le paramètre interne `triggerDepth` de `startRun()` — non atteignable aujourd'hui (aucune action n'émet encore d'événement), mais posé pour ne jamais permettre une chaîne de déclenchement qui s'auto-alimente |
| Nombre de steps         | `MAX_STEPS_PER_AUTOMATION` (20), vérifié à la création **et** à l'exécution (défense en profondeur)                                                                                                                                         |
| Action arbitraire       | Voir « Catalogue d'actions autorisées » — toute chaîne non enregistrée est rejetée à la création (`AutomationValidationError`) et, en défense en profondeur, à l'exécution                                                                  |
| Condition dynamique     | Aucun `eval`/`Function` — voir `condition-engine.ts`                                                                                                                                                                                        |

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

- `condition-engine.spec.ts` — validation et évaluation (20 tests).
- `actions/ops-actions-registry.service.spec.ts` — chaque action + rejet
  des actions non allowlistées (16 tests).
- `automation-templating.spec.ts` — résolution `{{event.*}}` (7 tests).
- `automations.service.spec.ts` — isolation organisation, accès non
  autorisé, conditions vrai/faux, idempotence (événement dupliqué),
  automation désactivée, échec de step, cycle d'approbation complet
  (attente / approbation / rejet / aucune exécution après rejet),
  concurrence, boucle interdite, redaction des secrets, historique
  append-only (26 tests).
- `examples/automation-examples.spec.ts` — les 3 exemples restent valides
  contre le moteur réel (7 tests).

**NO MERGE. NO DEPLOY.** En attente de revue Codex puis d'autorisation
explicite Romeo/Landry.
