# RC25 — Scheduled Automations Foundation

Rend réellement exécutables les automations dont le trigger est `scheduled`,
en réutilisant exactement le moteur RC20 (`AutomationsService.startRun()` via
la nouvelle méthode `triggerScheduled()`) — pas de second moteur d'exécution.

## Ce qui existait déjà, et n'a pas changé

- `AutomationTrigger.type = manual | scheduled | event`
- `AutomationTrigger.cronExpression`
- `Automation.lastRunAt` / `Automation.nextRunAt`
- `AutomationRun.triggerType = scheduled` (déjà dans l'union de types)

Ces champs étaient stockés mais rien ne les lisait avant RC25.

## Architecture

```
AutomationSchedulerService
  @Cron(EVERY_MINUTE) handleTick()
    → runDueAutomations(now)
        → SELECT automations WHERE enabled=true
                                 AND trigger.type='scheduled'
                                 AND nextRunAt <= now
        → pour chaque automation due :
            following = computeNextOccurrence(cron, timezone, now)
            claim = UPDATE automations
                    SET nextRunAt = following, lastRunAt = now
                    WHERE id = automation.id AND nextRunAt = <valeur observée>
            si claim.count === 0 : une autre instance a gagné → skip
            sinon : AutomationsService.triggerScheduled(automation, scheduledFor)
                      → startRun() (RC-20, inchangé) avec triggerType='scheduled'
```

## Décision architecturale : un seul dispatcher, pas un job par automation

Le nombre d'automations est dynamique (créées/activées/modifiées par les
utilisateurs à tout moment). Un `@Cron` par automation nécessiterait un
enregistrement/désenregistrement dynamique via `SchedulerRegistry` — plus
fragile qu'un scan périodique unique. `@nestjs/schedule` n'est donc utilisé
que pour **un seul** `@Cron(CronExpression.EVERY_MINUTE)` statique.

## Garantie de concurrence

**Deux couches indépendantes**, aucune ne remplace l'autre :

1. **Réclamation atomique** (la couche qui compte réellement) : un seul
   `UPDATE automations SET next_run_at = ... WHERE id = ? AND next_run_at = ?`
   — comparaison-et-échange (compare-and-swap) classique. Exactement le même
   schéma déjà utilisé et testé dans `AutomationsService.approveRun()` /
   `rejectRun()` de RC20. Postgres sérialise deux `UPDATE` concurrents sur la
   même ligne : le perdant relit une valeur déjà modifiée par le gagnant, son
   `WHERE` ne matche plus, `count = 0`.
2. **Contrainte d'unicité `(organizationId, dedupKey)`** sur `AutomationRun`
   (déjà existante, déjà race-safe dans `persistRun()` — testée pour le
   trigger `event`) comme défense supplémentaire, au cas où la réclamation
   serait un jour contournée.

**Clé de déduplication** : `automation:${automationId}:scheduled:${scheduledFor.toISOString()}`,
où `scheduledFor` est l'échéance **réclamée** (`nextRunAt` observé avant la
réclamation), jamais la nouvelle valeur recalculée.

## Fuseau horaire

`AutomationTrigger.timezone` (`String @default("UTC")`, colonne dédiée —
jamais caché dans le JSON `config`). Validation stricte via
`Intl.DateTimeFormat(undefined, { timeZone })`, **avant** tout appel à
`cron-parser` (dont l'erreur native sur un fuseau invalide est un message
interne peu clair). Jamais déduit de la ville/pays de l'organisation.

## Politique de rattrapage après interruption

`nextRunAt` est un scalaire unique par automation, pas une file d'occurrences
manquées. Le calcul de la nouvelle valeur est **toujours ancré sur `now`**
(l'instant du tick), jamais incrémenté depuis l'ancienne `nextRunAt`. Donc :
quel que soit le nombre d'occurrences manquées pendant un arrêt du service,
il y a exactement **une** réclamation, **un** run, puis la prochaine valeur
saute directement à la prochaine occurrence future — jamais de rafale.

**Limite connue et acceptée** : si le processus plante entre la réclamation
réussie (nextRunAt déjà avancé) et l'appel effectif à `triggerScheduled()`,
cette occurrence précise est perdue (elle ne sera pas rejouée au tick
suivant, puisque `nextRunAt` a déjà été avancé). C'est la même classe de
risque que RC20 accepte déjà entre `persistRun()` et `executeSteps()` pour
les triggers manuel/événementiel — non aggravée par RC25, documentée ici
plutôt que traitée par une garantie transactionnelle nouvelle.

## Calcul de `nextRunAt`

Un seul point de calcul (`AutomationsService.resolveNextRunAt()`), appelé
**inconditionnellement** dans `create()`, `update()` et `setEnabled()` à
partir de l'état *effectif* post-changement (jamais un `if` par champ
spécifique — un automation désactivée, un trigger non-`scheduled`, ou un
`cronExpression` absent renvoient toujours `null`). Le dispatcher calcule sa
propre valeur suivante séparément, ancrée sur `now`, via la même fonction
pure `computeNextOccurrence()`.

## Approbation

Inchangé : `triggerScheduled()` appelle le `startRun()` existant tel quel.
Si `requiresApproval`, le run reste `waiting_approval` avec `plannedSteps`
déjà figées — aucune étape ne s'exécute avant approbation manuelle.

## Limites connues

- Résolution pratique ~1 minute (liée à la fréquence du tick).
- Pas de verrou distribué au-delà de la réclamation DB elle-même — testé
  comme sûr avec plusieurs instances (voir tests), pas seulement documenté
  comme tel.
- Une automation dont `enabled`/`trigger` change *entre* le `findMany()` du
  tick et sa réclamation individuelle peut, dans de rares cas, déclencher un
  run de plus que prévu (borné à un seul run superflu, jamais une rafale) —
  la même classe de décalage lecture-puis-action que le reste du moteur RC20
  accepte déjà (ex. `emitEvent()`).
- Pas de retry automatique des étapes en échec (RC27).

## Fichiers créés

- `src/ops-automation/cron-schedule.ts`
- `src/ops-automation/automation-scheduler.service.ts` (+ `.spec.ts`)
- `prisma/migrations/20260916080000_add_automation_trigger_timezone/`
- `docs/RC25_SCHEDULED_AUTOMATIONS.md`

## Fichiers modifiés

- `prisma/schema.prisma` — `AutomationTrigger.timezone`.
- `src/ops-automation/dto/automation-trigger.dto.ts` — `timezone?: string`.
- `src/ops-automation/automations.service.ts` — `validateTrigger()` valide
  cron+tz ; `create()`/`update()`/`setEnabled()` recalculent `nextRunAt` ;
  nouvelle méthode publique `triggerScheduled()`.
- `src/ops-automation/automations.service.spec.ts` — tests `nextRunAt` +
  `triggerScheduled`.
- `src/ops-automation/ops-automation.module.ts` — enregistre
  `AutomationSchedulerService`.
- `src/app.module.ts` — `ScheduleModule.forRoot()`.
- `package.json` — `cron-parser@^5.10.1`, `@nestjs/schedule@^6.1.3`.

## Dépendances ajoutées

- `cron-parser@5.10.1` (CJS, dépend de `luxon@3.7.2` pour le calcul
  timezone-aware) — analyse et évaluation d'expressions cron.
- `@nestjs/schedule@6.1.3` (CJS ; la 12.x est pure ESM et casserait Jest,
  même piège que `@nestjs/event-emitter@12.x` en RC23) — un seul `@Cron`
  statique.

`npm audit` : 19 → 20 en apparence, mais pas de nouveau paquet vulnérable —
`@nestjs/schedule` dépend de `@nestjs/core`, déjà dans la chaîne
pré-existante `@nestjs/platform-express`/`multer` déjà déférée à une tâche de
hardening séparée (même schéma que RC23/RC24).

## Ce qui reste hors-scope (RC futures)

- Frontend (choix quotidien/hebdomadaire/mensuel, heure, jour, fuseau,
  affichage de `nextRunAt`) — PR draft séparée après validation du backend.
- Retries automatiques des étapes (RC27).
- Verrou distribué au-delà de la réclamation DB (suffisant pour le
  déploiement actuel ; à revisiter si un vrai besoin de scaling horizontal
  apparaît).

## Tests exécutés

```
npx jest --silent                    → 55 suites, 364 tests, tous passants
                                        (338 pré-existants + 26 nouveaux)
npx tsc --noEmit -p tsconfig.json    → aucune nouvelle erreur (1 erreur
                                        pré-existante et sans rapport,
                                        documentée depuis RC23)
node scripts/check-eslint-baseline.mjs
  eslint-report.json 74 23           → ESLint debt: 74 errors, 23 warnings
                                        (baseline: 74/23) — aucune hausse
npm run build                        → prisma generate + nest build : succès
sh -n deploy/github-deploy.sh        → syntaxe shell OK
python -m unittest discover
  -s deploy/tests -p "test_*.py"     → 22 tests, tous passants
docker compose ... config --quiet    → configuration valide
```
