# RC27 hardening — politique de rejeu, bail durable, course sur claim

RC-27 (reprises automatiques d'étapes) avait trois failles réelles : (1) aucune politique de rejeu par action — tout était retenté par défaut dès lors que l'erreur "avait l'air" transitoire ; (2) la toute première tentative d'une étape n'était jamais couverte par un bail — un crash pendant cette tentative synchrone laissait la ligne `running` indéfiniment, invisible du dispatcher ; (3) un ancien worker qui avait perdu son claim (action longue, bail dépassé) continuait quand même à écrire le résultat et à enchaîner les étapes suivantes.

## 1. Politique de rejeu explicite (registre d'actions)

`OpsActionDescriptor.retrySafe: boolean` — jamais de valeur par défaut, chaque action doit choisir explicitement. `OpsActionsRegistryService.isRetrySafe(actionType)`.

| Action | `retrySafe` | Raison |
|---|---|---|
| `robia.audit.run_diagnostic` | **false** | crée un nouvel `Audit` à chaque appel, aucune clé d'idempotence |
| `robia.opportunities.regenerate` | true | idempotence déjà prouvée (RC-19) |
| `robia.report.prepare_organization_summary` | true | lecture seule |
| `robia.action_items.create_internal_task` | **false** | crée un nouvel `ActionItem` à chaque appel |
| `robia.notification.send_email` | true | déduplication stable par `stepRunId` (RC-26) |
| `robia.odc.prepare_application_summary` | true | écrasement déterministe du même champ, aucun autre effet |
| `robia.odc.flag_missing_documents` | **false** | append un `OdcHistoryEvent` et ré-émet un événement à *chaque* appel, même sans changement d'état — pas nommée explicitement par la demande, mais la même règle ("prouvée idempotente ou lecture seule") s'applique |
| `robia.odc.create_review_task` | **false** | crée un nouvel `ActionItem` à chaque appel — même défaut que `create_internal_task`, non nommée explicitement mais couverte par la même règle |

Une action non `retrySafe` n'est **jamais** retentée automatiquement, y compris sur une erreur qui aurait l'air transitoire (`ECONNRESET`, 5xx). Elle échoue le run immédiatement, comme une erreur permanente.

## 2. Bail durable dès la première tentative

Chaque tentative (première ou reprise) reçoit désormais `claimedAt` **et** un `claimToken` opaque (UUID), jamais laissés `null` pour la première tentative comme c'était documenté (et accepté) auparavant. Un crash pendant cette tentative synchrone laisse la ligne `running` avec un bail réel, exactement comme une reprise abandonnée — le dispatcher la récupère une fois le bail expiré.

Deux claims *séparés* dans `retryStep()`, jamais fusionnés :
1. `dueScheduledRetryWhere` — une ligne `retry_scheduled` due. Avoir atteint ce statut a déjà validé `isRetrySafe()` une fois ; toujours sûr à rejouer.
2. `abandonedRunningClaimWhere` — une ligne `running` dont le bail a expiré (première tentative ou reprise, plantée, résultat inconnu). `isRetrySafe()` est revérifié ici, après avoir gagné le claim (le type d'action n'est connu qu'à ce moment) : si non sûre, le run échoue avec un message rédigé indiquant un résultat indéterminé et une intervention humaine nécessaire — jamais de ré-exécution à l'aveugle.

Une ligne `running` abandonnée dont le budget de tentatives est déjà épuisé n'entre dans aucun des deux claims (les deux exigent `attemptCount < MAX_STEP_ATTEMPTS`) : `failExhaustedAbandonedStep()` la fait échouer explicitement pour qu'elle ne reste jamais bloquée.

## 3. Course sur les actions longues

Chaque écriture de résultat passe par `commitStepAttempt()`, une UPDATE conditionnelle sur `claimToken` (jamais sur `claimedAt`, pas assez stable comme identifiant d'exclusivité). Si `count !== 1`, un autre worker a déjà repris la ligne comme abandonnée pendant que cette tentative tournait encore — l'appelant s'arrête net : jamais de suite du run (`runStepsFrom`), jamais d'échec forcé (`finishRun`) au nom d'un claim déjà perdu.

Risque résiduel assumé (documenté plutôt que masqué par un heartbeat complet) : une action **retry-safe** qui dépasse réellement les 5 minutes de bail peut être exécutée une seconde fois en parallèle par un autre worker avant que la première ne termine — gaspillage de travail, jamais une incohérence, puisque *retry-safe* signifie par construction "sûr à exécuter plus d'une fois". Une action non *retry-safe* ne peut jamais être ré-exécutée en pareil cas (voir §2) : le seul dommage possible reste un doublon de travail idempotent, jamais un doublon de side-effect réel.

## 4. Dispatcher borné

`automationStepRun.findMany` : `orderBy: [{createdAt:'asc'},{id:'asc'}]` + `take: STEP_RETRY_MAX_BATCH_SIZE` (50) — dans la requête elle-même, jamais un tri/slice après coup. Traitement via un pool à concurrence bornée (`STEP_RETRY_MAX_CONCURRENCY` = 5), copie du pattern déjà utilisé par `AutomationSchedulerService` (RC-25). Isolation des erreurs déjà en place, inchangée : l'échec d'une ligne ne stoppe jamais les autres.

## Migration

`20260921120000_automation_step_run_claim_token` — additive, `automation_step_runs.claim_token TEXT NULL`.

## Hors périmètre

Un vrai heartbeat périodique (prolongation active du bail pendant une action encore en cours) — écarté au profit de la stratégie sûre décrite au §3, qui couvre la vraie question de correction (jamais de double side-effect non-idempotent, jamais un ancien worker qui continue) sans la complexité d'un timer à gérer sur le chemin synchrone de la première tentative.
