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
        → reconcileMissingNextRunAt(now)     // voir "Réconciliation" plus bas
        → SELECT automations WHERE enabled=true
                                 AND trigger.type='scheduled'
                                 AND nextRunAt <= now
                                 AND (scheduledClaimedAt IS NULL
                                      OR scheduledClaimedAt < now - LEASE_MS)
        → pour chaque automation due :
            // Phase 1 — réclamation (lease), pas d'avance de nextRunAt ici
            claim = UPDATE automations
                    SET scheduled_claimed_at = now
                    WHERE id = ? AND next_run_at = <valeur observée>
                          AND enabled = true
                          AND (scheduled_claimed_at IS NULL
                               OR scheduled_claimed_at < now - LEASE_MS)
            si claim.count === 0 : perdu la course, ou plus éligible → skip

            // Phase 2 — relecture fraîche, ferme la fenêtre de course avec
            // un disable/modify survenu entre la réclamation et ici
            fresh = SELECT automation WHERE id = ? (avec trigger)
            si fresh n'est plus enabled/scheduled : libère le lease, skip
                                                     (nextRunAt intact)

            // Phase 3 — exécution via le moteur RC-20, inchangé
            AutomationsService.triggerScheduled(fresh, scheduledFor)
                      → startRun() avec triggerType='scheduled'
            // si cet appel lève (run jamais créé durablement), la Phase 4
            // n'est JAMAIS atteinte : nextRunAt reste intact, à réessayer

            // Phase 4 — seulement après un triggerScheduled() réussi
            following = computeNextOccurrence(cron, timezone, now)
            UPDATE automations
            SET next_run_at = following, scheduled_claimed_at = NULL
            WHERE id = ? AND next_run_at = <valeur réclamée>
```

## Décision architecturale : un seul dispatcher, pas un job par automation

Le nombre d'automations est dynamique (créées/activées/modifiées par les
utilisateurs à tout moment). Un `@Cron` par automation nécessiterait un
enregistrement/désenregistrement dynamique via `SchedulerRegistry` — plus
fragile qu'un scan périodique unique. `@nestjs/schedule` n'est donc utilisé
que pour **un seul** `@Cron(CronExpression.EVERY_MINUTE)` statique.

## Concurrence bornée au sein d'un tick (hardening fix)

Revue Claude sur PR#47 : `runDueAutomations()` traitait tout le due-set
strictement séquentiellement (`for...await`), donc une automation lente
retardait toutes les suivantes du même tick. Corrigé sans toucher à la
réclamation CAS/bail elle-même (Phases 1 à 4 ci-dessous, chacune totalement
indépendante par ligne — donc sûre à paralléliser) :

- **Ordre déterministe** : le due-set est trié par `nextRunAt` croissant
  (l'échéance la plus en retard en premier), `id` comme départage stable —
  jamais l'ordre de retour, non spécifié, de la requête SQL.
- **Batch borné** : au plus `SCHEDULER_MAX_BATCH_SIZE` (50) automations
  tentées par tick, quelle que soit la taille du due-set. Le reste attend
  simplement le tick suivant (une minute plus tard) — son propre `nextRunAt`
  n'est jamais touché, exactement comme une occurrence qui aurait perdu la
  course de réclamation ou dont le bail n'est pas encore périmé : rien n'est
  perdu, seulement retardé, et la prochaine fois ce sera nécessairement le
  tour des occurrences alors les plus en retard (l'ordre est recalculé à
  chaque tick).
- **Concurrence bornée** : le batch est traité par un petit pool
  (`runWithBoundedConcurrency()`, sans nouvelle dépendance) d'au plus
  `SCHEDULER_MAX_CONCURRENCY` (5) automations en vol simultanément — ni tout
  le batch d'un coup (`Promise.allSettled` illimité), ni une par une.
- **Isolation des erreurs inchangée** : le `try/catch` par automation est
  toujours exactement à la même place, seulement maintenant à l'intérieur du
  worker du pool plutôt que du corps de la boucle — l'échec d'une automation
  ne peut donc arrêter ni ses siblings concurrents, ni le reste du batch.
- **Aucune garantie de dédup/multi-instance modifiée** : la réclamation CAS
  (Phase 1), la relecture fraîche (Phase 2) et l'avance conditionnelle de
  `nextRunAt` (Phase 4) sont exactement les mêmes qu'avant, ligne par ligne —
  les tests de concurrence entre deux instances de scheduler et de reprise
  après plantage (déjà présents avant ce fix) passent tels quels, sans
  modification, avec le pool ajouté autour.

Les deux constantes vivent dans `automation.constants.ts`, aux côtés des
autres garde-fous RC-20/RC-25.

## Réclamation en deux phases avec bail (RC-25 review fix)

La conception initiale réclamait l'occurrence et avançait `nextRunAt` dans le
même `UPDATE` — un plantage entre ce `UPDATE` et l'appel effectif à
`triggerScheduled()` perdait l'occurrence définitivement, sans aucune trace
permettant de la rejouer. Contrairement aux triggers `event` de RC-20 (où un
événement perdu peut en principe être ré-émis par sa source), une occurrence
de cron manquée n'a pas de source de rejeu.

`Automation.scheduledClaimedAt` (`DateTime?`, nullable, additif) est un
**bail** sur la réclamation en cours :

- Posé (`= now`) uniquement à la Phase 1 — jamais en même temps que l'avance
  de `nextRunAt`.
- Libéré (`= null`) uniquement une fois le run **durablement créé** (Phase 4)
  ou quand la relecture fraîche (Phase 2) montre que l'automation n'est plus
  éligible.
- Si le processus plante n'importe où entre la Phase 1 et la Phase 4 (y
  compris pendant `triggerScheduled()` s'il ne parvient jamais à créer le
  run), le bail reste posé mais `nextRunAt` n'a jamais bougé : l'occurrence
  n'est ni perdue ni rejouée en rafale, seulement retardée jusqu'à ce que le
  bail devienne périmé (`SCHEDULED_CLAIM_LEASE_MS`, 5 minutes) et qu'une
  autre instance (ou la même, après redémarrage) la réclame de nouveau avec
  exactement le même `scheduledFor` / `dedupKey`.

## Fermeture de la course avec un disable/modify (RC-25 review fix)

La Phase 1 exige `enabled = true` dans son `WHERE` — pas seulement dans le
`SELECT` du due-set — donc un disable qui arrive entre ce `SELECT` et la
réclamation fait simplement échouer le `WHERE` (`count = 0`), sans exécution.

La Phase 2 (relecture fraîche juste après avoir gagné le bail) ferme la
fenêtre plus étroite encore — mais vérifier seulement `enabled` / le type de
trigger / la présence du cron n'y suffit pas : un enchaînement
désactivation-puis-réactivation, ou une édition du cron/fuseau, qui arrive
entre la réclamation et cette relecture laisse `enabled = true` et un
trigger valide, alors même que `AutomationsService.update()` /
`setEnabled()` ont, entre-temps, réécrit `nextRunAt` vers une **nouvelle**
échéance et effacé `scheduledClaimedAt` (voir plus bas). Sans re-vérifier
ces deux champs, le scheduler exécuterait l'automation contre l'échéance
périmée qu'il a réclamée à l'origine plutôt que celle réellement due
aujourd'hui. La Phase 2 exige donc en plus, après la relecture :

- `fresh.nextRunAt` égal exactement à `scheduledFor` (l'échéance réclamée) ;
- `fresh.scheduledClaimedAt` égal exactement au timestamp posé par cette
  réclamation (`now`, la valeur passée à la Phase 1).

Toute divergence sur l'un ou l'autre signifie que le bail que cet appel
croit détenir n'est plus celui présent sur la ligne : il annule l'exécution
et libère (silencieusement, sans effet si déjà nul) le bail, sans jamais
avancer `nextRunAt`.

`AutomationsService.update()` et `.setEnabled()` participent activement à
cette fermeture : chaque appel qui réécrit `nextRunAt` (systématique, voir
« Calcul de `nextRunAt` » plus bas) efface aussi
inconditionnellement `scheduledClaimedAt` — tout bail en cours pour
l'**ancienne** valeur de `nextRunAt` est nécessairement périmé dès que ce
`UPDATE` commite, qu'il ait ou non déjà été réclamé par le scheduler.

Une automation désactivée/modifiée avant la création du run n'est donc
**jamais** exécutée — pas même une seule fois de trop, contrainte
explicitement requise en vue d'une future action externe (ex. un envoi
d'email en RC27).

**Point de linéarisation** : la Phase 3 (l'appel à `triggerScheduled()`) est
le point de linéarisation de toute cette séquence. Une fois la Phase 2
passée avec succès (bail + `nextRunAt` confirmés cohérents), cet appel est
garanti être le seul, pour cette occurrence précise, à jamais atteindre la
Phase 3 — aucun autre appel, sur cette instance ou une autre, ne peut déjà
s'y trouver ou s'y trouver plus tard pour la même occurrence : la Phase 1 en
a exclu tout concurrent au moment de la réclamation, et la Phase 2 vient de
reconfirmer qu'aucune modification n'a entre-temps rendu ce bail caduc.
Passé ce point, l'occurrence est considérée comme **prise en charge** :
c'est la garantie sur laquelle repose l'absence de double exécution, la
contrainte d'unicité `(organizationId, dedupKey)` sur `AutomationRun`
n'intervenant qu'en défense supplémentaire (voir « Garantie de
concurrence »).

Enfin, la Phase 4 (avance de `nextRunAt`) inclut elle aussi
`scheduledClaimedAt: now` dans son `WHERE` — pas seulement `nextRunAt` — pour
qu'un worker resté bloqué au-delà de la durée du bail, et dont la
réclamation a depuis été reprise par une autre instance, ne puisse ni
libérer ni écraser le bail que cette autre instance détient désormais, même
dans le cas rare où `nextRunAt` se retrouverait relu à l'identique.

## Réconciliation des automations pré-RC25 (RC-25 review fix)

Une automation déjà `enabled=true` + `trigger.type='scheduled'` avant que
RC25 ne soit déployé a `nextRunAt = null` (rien ne le calculait avant). Un
filtre `nextRunAt <= now` ne matche jamais `NULL` : sans intervention, une
telle automation ne serait jamais prise en compte. `reconcileMissingNextRunAt()`
tourne au début de chaque tick, cherche exactement ce sous-ensemble (jamais
les triggers `manual`/`event`), et initialise `nextRunAt` via un
`UPDATE ... WHERE next_run_at IS NULL` — concurrency-safe par construction :
si deux instances le font en même temps, une seule gagne.

## Garantie de concurrence

**Deux couches indépendantes**, aucune ne remplace l'autre :

1. **Réclamation atomique par bail** (la couche qui compte réellement) : le
   `UPDATE ... WHERE` de la Phase 1 ci-dessus — comparaison-et-échange
   (compare-and-swap) classique. Le même schéma déjà utilisé et testé dans
   `AutomationsService.approveRun()` / `rejectRun()` de RC20. Postgres
   sérialise deux `UPDATE` concurrents sur la même ligne : le perdant relit
   une valeur déjà modifiée par le gagnant, son `WHERE` ne matche plus,
   `count = 0`.
2. **Contrainte d'unicité `(organizationId, dedupKey)`** sur `AutomationRun`
   (déjà existante, déjà race-safe dans `persistRun()` — testée pour le
   trigger `event`) comme défense supplémentaire, au cas où la réclamation
   serait un jour contournée.

**Clé de déduplication** : `automation:${automationId}:scheduled:${scheduledFor.toISOString()}`,
où `scheduledFor` est l'échéance **réclamée** (`nextRunAt` observé avant la
réclamation), jamais la nouvelle valeur recalculée.

## Fuseau horaire

`AutomationTrigger.timezone` (`String?`, colonne dédiée — jamais caché dans
le JSON `config`). Validation stricte via
`Intl.DateTimeFormat(undefined, { timeZone })`, **avant** tout appel à
`cron-parser` (dont l'erreur native sur un fuseau invalide est un message
interne peu clair). Jamais déduit de la ville/pays de l'organisation.

### Invariant persisté (hardening fix)

Revue Claude sur PR#47 (déjà mergée) : `AutomationsService.update()` pouvait
laisser survivre un fuseau résiduel d'un ancien trigger `scheduled` sur un
trigger devenu `event`/`manual` (la colonne avait `@default("UTC")` pour
**tout** type de trigger, et `validateTrigger()` ne rejetait qu'une valeur
explicitement fournie, jamais celle héritée du fallback
`existing.trigger?.timezone`). Contradiction directe avec ce que ce document
affirmait déjà être impossible.

Invariant désormais réellement appliqué, dans `create()` **et** `update()`,
via `AutomationsService.resolveTriggerTimezone()` — le seul point qui décide
ce qui est persisté :

| Type de trigger écrit | Valeur persistée |
|---|---|
| `scheduled` | non nulle — la valeur fournie, sinon celle déjà en base **seulement si** le trigger existant était lui-même `scheduled`, sinon `UTC` |
| `event` | toujours `null` |
| `manual` | toujours `null` |

Cas particuliers explicitement couverts (tests dans
`automations.service.spec.ts`, describe `trigger timezone invariant`) :

- `scheduled → event` / `scheduled → manual` : `timezone`, `cronExpression`
  et `nextRunAt` sont tous effacés dans le même `update()`.
- `event`/`manual → scheduled` sans nouvelle timezone fournie : `UTC`.
- `scheduled → scheduled` sans nouvelle timezone fournie : la timezone
  existante est conservée telle quelle.
- Une timezone résiduelle sur une ligne historiquement incohérente (un
  trigger non-`scheduled` dont la colonne n'a, pour une raison quelconque,
  jamais été mise à `null` — exactement le cas que le bug ci-dessus pouvait
  produire) n'est **jamais** réutilisée : `resolveTriggerTimezone()` ne
  regarde la valeur existante que si le type de trigger existant était
  aussi `scheduled`.
- `update()` sans `dto.trigger` du tout (un champ non lié au trigger, par
  ex. `name`) : la ligne `trigger` n'est pas ré-écrite, donc la timezone
  déjà persistée est simplement reprise telle quelle pour le calcul de
  `nextRunAt` — jamais re-dérivée.

La migration `20260917090000_automation_trigger_timezone_invariant`
rend la colonne nullable, supprime le défaut `'UTC'` au niveau DB (la
décision revient désormais entièrement au code, par type), et corrige les
données historiques : toute ligne dont le type n'est pas `scheduled` voit sa
`timezone` mise à `null` rétroactivement.

`AutomationSchedulerService` lit `trigger.timezone` uniquement pour un
trigger déjà confirmé `scheduled` (Phase 4, réconciliation) ; un `null`
inattendu à cet endroit précis dégrade sur `UTC` avec un warning loggé —
défensif seulement, jamais le chemin attendu sous l'invariant ci-dessus.

## Contrat cron : 5 champs uniquement (RC-25 review fix)

`computeNextOccurrence()` rejette explicitement (`assertFiveFieldCronExpression()`,
avant même que `cron-parser` ne voie la chaîne) toute expression qui n'a pas
exactement 5 champs espacés (minute heure jour-du-mois mois jour-de-semaine).
`cron-parser` accepte par ailleurs un 6ᵉ champ (secondes) et les raccourcis
`@daily`/`@weekly`/etc., mais le dispatcher ne tique qu'une fois par minute
(`EVERY_MINUTE`) : une expression à la seconde près donnerait l'illusion
d'une fréquence qu'elle n'aura jamais réellement. Le rejet porte un message
explicite plutôt que de laisser `cron-parser` échouer silencieusement ou de
façon peu claire. `validateTrigger()` rejette en plus toute combinaison de
champs incohérente avec le type de trigger (`eventType` sur un trigger
`scheduled`, `cronExpression`/`timezone` sur un trigger `event` ou `manual`)
— une donnée legacy/invalide de ce genre ne peut donc jamais survivre à un
changement de type de trigger vers `scheduled` et déclencher une 500 plus
tard.

## Politique de rattrapage après interruption

`nextRunAt` est un scalaire unique par automation, pas une file d'occurrences
manquées. Le calcul de la nouvelle valeur est **toujours ancré sur `now`**
(l'instant du tick), jamais incrémenté depuis l'ancienne `nextRunAt`. Donc :
quel que soit le nombre d'occurrences manquées pendant un arrêt du service,
il y a exactement **une** réclamation, **un** run, puis la prochaine valeur
saute directement à la prochaine occurrence future — jamais de rafale.

**Résolu (RC-25 review fix)** : avec la réclamation en deux phases décrite
plus haut, `nextRunAt` n'est plus avancé au moment de la réclamation mais
seulement après création durable du run — un plantage entre les deux ne
perd donc plus l'occurrence, voir « Réclamation en deux phases avec bail ».

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
  tick et la réclamation (Phase 1) fait simplement échouer cette
  réclamation ; entre la réclamation et la relecture fraîche (Phase 2), la
  relecture elle-même annule l'exécution — dans les deux cas, zéro run de
  trop, voir « Fermeture de la course avec un disable/modify ».
- Pas de retry automatique des étapes en échec (RC27).
- Pas d'intégration Postgres réelle dans la suite de tests (aucune base
  vivante dans cet environnement) : la preuve de la sémantique CAS/bail
  repose sur `FakeSchedulerPrisma`, un double synchrone find-then-mutate
  fidèle aux contraintes Postgres réelles (voir
  `automation-scheduler.service.spec.ts`), plus le test séquentiel
  crash-puis-récupération qui rejoue deux ticks sur le même état partagé.

## Fichiers créés

- `src/ops-automation/cron-schedule.ts`
- `src/ops-automation/automation-scheduler.service.ts` (+ `.spec.ts`)
- `prisma/migrations/20260916080000_add_automation_trigger_timezone/`
- `prisma/migrations/20260916090000_automation_scheduled_claim_and_index/`
- `prisma/migrations/20260917090000_automation_trigger_timezone_invariant/`
  (hardening fix)
- `docs/RC25_SCHEDULED_AUTOMATIONS.md`

## Fichiers modifiés

- `prisma/schema.prisma` — `AutomationTrigger.timezone` (hardening fix :
  `String?`, nullable, plus de `@default("UTC")` — voir « Invariant
  persisté ») ; `Automation.scheduledClaimedAt` (bail de réclamation) ;
  `@@index([enabled, nextRunAt])`.
- `src/ops-automation/dto/automation-trigger.dto.ts` — `timezone?: string`.
- `src/ops-automation/automations.service.ts` — `validateTrigger()` valide
  cron+tz et rejette les combinaisons de champs incohérentes par type de
  trigger ; `create()`/`update()`/`setEnabled()` recalculent `nextRunAt` via
  `resolveNextRunAt()` (jamais d'exception propagée, dégrade en `null` avec
  un warning loggé, entièrement redacté) ; `update()`/`setEnabled()` effacent
  aussi `scheduledClaimedAt` à chaque réécriture de `nextRunAt` ; nouvelle
  méthode publique `triggerScheduled()` ; **hardening fix** : nouvelle
  méthode privée `resolveTriggerTimezone()`, seul point qui décide de la
  timezone persistée (voir « Invariant persisté »).
- `src/ops-automation/automations.service.spec.ts` — tests `nextRunAt` +
  `triggerScheduled` + validation des combinaisons de champs + effacement de
  `scheduledClaimedAt` par `update()`/`setEnabled()` ; **hardening fix** :
  nouveau describe `trigger timezone invariant` (7 tests).
- `src/ops-automation/automation-scheduler.service.ts` — **hardening fix** :
  tri déterministe + batch borné (`SCHEDULER_MAX_BATCH_SIZE`) + pool à
  concurrence bornée (`runWithBoundedConcurrency()`,
  `SCHEDULER_MAX_CONCURRENCY`) autour de `processDueAutomation()`, inchangé
  lui-même ; repli défensif `UTC` si `trigger.timezone` est `null` alors que
  le type est déjà confirmé `scheduled` (ne devrait jamais arriver sous
  l'invariant, warning loggé si ça arrive quand même).
- `src/ops-automation/automation-scheduler.service.spec.ts` —
  **hardening fix** : nouveau describe `bounded concurrency within a tick`
  (5 tests).
- `src/ops-automation/automation.constants.ts` — **hardening fix** :
  `SCHEDULER_MAX_CONCURRENCY` (5), `SCHEDULER_MAX_BATCH_SIZE` (50).
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

## Hardening fix (revue Claude sur PR#47, déjà mergée)

Une revue de code indépendante de la PR déjà mergée #47 a identifié deux
défauts non bloquants pour la production mais contraires à ce que ce
document affirmait :

1. Fuite possible d'un fuseau résiduel lors d'un changement de type de
   trigger — voir « Invariant persisté » sous « Fuseau horaire ».
2. Traitement strictement séquentiel du due-set au sein d'un tick — voir
   « Concurrence bornée au sein d'un tick ».

Les deux sont corrigés sur une branche séparée (`fix/rc25-scheduler-hardening`),
sans toucher au reste du moteur RC25 (réclamation CAS/bail, garanties
multi-instance, dédup) — voir les sections dédiées ci-dessus pour le détail.

## Tests exécutés

```
npx jest --silent                    → 62 suites, 481 tests, tous passants
npx tsc --noEmit -p tsconfig.json    → aucune nouvelle erreur (1 erreur
                                        pré-existante et sans rapport,
                                        documentée depuis RC23)
npx eslint "{src,apps,libs,test}/**/*.ts" --format json
  --output-file eslint-report.json
node scripts/check-eslint-baseline.mjs
  eslint-report.json 74 23           → ESLint debt: 74 errors, 23 warnings
                                        (baseline: 74/23) — aucune hausse
npm run build                        → prisma generate + nest build : succès
npx prisma validate                  → schéma valide
python -m unittest discover
  -s deploy/tests -p "test_*.py"     → 22 tests, tous passants
docker compose -f docker-compose.production.yml
  config --quiet                     → configuration valide
```
