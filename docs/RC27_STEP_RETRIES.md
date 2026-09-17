# RC27 — Reprises automatiques au niveau des étapes

## Périmètre

Avant RC27, `AutomationsService.executeSteps()` exécutait les étapes d'un run
dans l'ordre et faisait échouer tout le run dès la première étape en erreur —
qu'il s'agisse d'une entrée invalide (jamais récupérable) ou d'un aléa réseau
temporaire (une régénération d'audit qui échoue une fois, une erreur DB
passagère). RC27 introduit une reprise automatique, bornée et avec backoff,
au niveau de l'étape elle-même : une erreur transitoire replanifie une
nouvelle tentative de la même étape au lieu de faire échouer tout le run
immédiatement.

Aucune modification du moteur RC20 lui-même (condition engine, registre
d'actions, garde-fous) ni du contrat API existant (`AutomationRun`,
`AutomationStepRun`) au-delà de champs additifs nullable/à valeur par défaut.
Aucune nouvelle route.

## Politique de reprise (`step-retry-policy.ts`)

- **Budget** : `MAX_STEP_ATTEMPTS = 4` (1 tentative initiale + 3 reprises).
- **Backoff** : 1 min → 5 min → 30 min (`STEP_RETRY_BACKOFF_MS`). Reprend les
  trois premiers paliers de RC26 (`NotificationDispatcherService`), sans la
  queue longue (2 h / 12 h) : un échec d'étape est presque toujours un aléa
  interne ou réseau court, jamais une panne prolongée d'un fournisseur tiers.
- **Classification** (`isPermanentStepError()`) :
  - **Permanent** (jamais de reprise) : `InvalidOpsActionInputError`,
    `UnknownOpsActionError` (les deux erreurs propres au registre d'actions),
    et toute `HttpException` 4xx — le même signal « erreur client » que
    lèvent déjà `AuditsService`/`OpportunitiesService`/`NotificationsService`/
    `ActionItemsService` dans tout le code (`NotFoundException`,
    `BadRequestException`, ...). Rejouer une entrée identique contre un état
    de base identique ne peut pas corriger un 404.
  - **Réessayable** (le cas par défaut) : toute autre erreur — `Error`
    générique, timeout réseau, `HttpException` 5xx ou sans statut. Même
    discipline que RC26 : une erreur inconnue n'est jamais présumée
    permanente.

## Architecture — double claim avec bail (RC25/RC26)

`AutomationStepRun` gagne trois champs additifs : `attemptCount` (incrémenté
à chaque tentative, y compris la première, jamais seulement à l'échec finale),
`nextAttemptAt` (quand `status = 'retry_scheduled'`) et `claimedAt` (bail sur
une reprise en cours).

1. **Tentative initiale** — inchangée dans son déroulement : synchrone, à
   l'intérieur de `runStepsFrom()` (l'ancien `executeSteps()`, désormais
   partagé entre le déclenchement initial et la reprise d'une exécution).
   Jamais de `claimedAt` posé ici : aucun risque de concurrence sur la toute
   première tentative.
2. **Échec transitoire** → `status: 'retry_scheduled'`, `nextAttemptAt = now
   + backoff[0]`. Le run reste `'running'` — il n'est jamais marqué `'failed'`
   tant qu'il reste des tentatives.
3. **`AutomationStepRetryDispatcherService`** — un tick périodique
   (`@Cron(EVERY_MINUTE)`), aussi minimal que `AutomationSchedulerService`
   (RC25) : il ne fait que lire l'ensemble dû et déléguer à
   `AutomationsService.retryStep(stepRunId, now)`, qui porte toute la
   logique métier (même séparation tick/moteur qu'entre
   `AutomationSchedulerService` et `triggerScheduled()`).
4. **`retryStep()`** — claim conditionnel (`UPDATE ... WHERE`), incrémentant
   `attemptCount` dès la réclamation (pas à la finalisation, pour qu'un crash
   en cours de tentative compte quand même — même discipline que
   `NotificationDelivery.attemptCount`), puis re-lecture pour confirmer le
   claim, puis tentative réelle via le même `attemptStep()` que la première
   tentative. Sur succès, reprend l'exécution des étapes suivantes
   (`runStepsFrom()` à partir de cette étape) ; sur nouvel échec, reprogramme
   le palier suivant ou fait échouer le run si le budget est épuisé.
5. **Bail (`claimedAt`)** : même durée que RC25/RC26 (5 minutes). Un
   `'running'` sans `claimedAt` (la tentative initiale synchrone) n'est
   jamais réclamable — seul un `'running'` avec un `claimedAt` devenu obsolète
   (un crash pendant une reprise) l'est. Voir le commentaire de
   `dueStepRetryWhere()` pour le détail de cette distinction, propre à RC27
   (RC26 n'a pas ce cas : toute tentative de `NotificationDelivery`, y
   compris la première, passe par le claim).

## Effets visibles

- `AutomationRun.status` reste `'running'` pendant qu'une étape est en attente
  de reprise — un run n'est `'failed'` qu'une fois le budget de l'étape
  épuisé, ou immédiatement pour une erreur permanente (comportement
  inchangé pour ce cas précis).
- `AutomationStepRun.status` gagne la valeur `'retry_scheduled'`.
- Aucun changement de route ni de DTO : `GET /ops/automations/runs/:id`
  renvoie simplement des runs qui peuvent rester `'running'` plus longtemps,
  avec `steps[].attemptCount`/`nextAttemptAt` déjà présents dans la réponse
  JSON existante (pas de nouveau champ à câbler côté frontend pour cette PR).

## Tests

`step-retry-policy.spec.ts` (16 scénarios : classification permanent/
réessayable pour chaque type d'erreur, ensemble dû `dueStepRetryWhere` pour
chaque combinaison statut/échéance/bail), `automations.service.spec.ts`
(+9 scénarios RC27 : reprise programmée sur erreur transitoire, non-reprise
sur 5xx classée réessayable, jamais de reprise sur erreur permanente,
`retryStep()` réussi reprenant les étapes suivantes, second échec
reprogrammant le palier suivant, épuisement du budget, no-op avant
échéance, un seul gagnant sur double claim concurrent, ré-acquisition d'un
bail expiré jamais d'un bail actif), `automation-step-retry-dispatcher.
service.spec.ts` (4 scénarios : délégation par ligne due, forme de la
requête, isolation des échecs par ligne, ensemble dû vide).

## Risques résiduels

- Le budget et le backoff (4 tentatives, 1/5/30 min) sont un choix
  raisonnable mais arbitraire ; aucune configuration par automation n'existe
  — toutes les automations partagent la même politique.
- Aucune visibilité frontend dédiée sur `retry_scheduled` dans cette PR (la
  liste/le détail des runs affichent déjà `steps[].status`/`error`, donc
  l'information existe, simplement sans traitement UI spécifique pour ce
  nouvel état) — laissé pour une itération frontend séparée si besoin.
