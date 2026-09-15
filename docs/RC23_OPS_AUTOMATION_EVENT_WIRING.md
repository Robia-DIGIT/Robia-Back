# RC23 — Ops Automation: wire `audit.completed` (Phase 1)

RC23 Phase 1 branche pour de vrai le système d'événements de RC20
(`AutomationsService.emitEvent()`), construit et testé en RC20 mais jamais
appelé — son propre code le disait explicitement : *"Nothing in this PR
calls this from AuditsService/MetaService/etc."*

**Portée volontairement étroite** : uniquement `audit.completed`, le cas le
plus simple (aucun nouveau modèle Prisma, aucune donnée métier nouvelle). Le
domaine ODC/candidatures (le "vrai" Ops Copilot métier) reste un chantier
séparé, hors-scope ici.

## Architecture avant / après

**Avant** :

```
AuditsService.run()/runSite() → audit.status = 'completed'
                                  (rien d'autre ne se passe)

AutomationsService.emitEvent() → existe, testé, jamais appelé
```

**Après** :

```
AuditsService.run()/runSite()
  → audit.status = 'completed'
  → EventEmitter2.emit('audit.completed', { organizationId, auditId, websiteId, globalScore })
                                  │ (fire-and-forget, in-process, synchrone,
                                  │  jamais attendu, ne peut jamais faire
                                  │  échouer la requête HTTP)
                                  ▼
AuditCompletedEventListener (ops-automation)
  @OnEvent('audit.completed')
  → try { AutomationsService.emitEvent(organizationId, 'audit.completed', auditId, payload) }
    catch { log, jamais de rethrow }
                                  ▼
AutomationsService.emitEvent()  (RC-20, inchangé)
  → dédup (organizationId, eventType, eventKey=auditId)
  → cherche les automations enabled, trigger event sur ce type, dans CETTE organisation
  → démarre un run par automation trouvée
```

## Décision architecturale : pourquoi un événement in-process, pas un appel direct

`OpsAutomationModule` importe déjà `AuditsModule` (pour ses propres actions
`robia.audit.run_diagnostic` / `robia.opportunities.regenerate`). Si
`AuditsService` appelait directement `AutomationsService`, on obtiendrait
`AuditsModule ↔ OpsAutomationModule` — un import de module circulaire.

Deux options existaient :
- `forwardRef()` NestJS — fonctionne, mais se reproduirait à l'identique
  pour chaque futur émetteur d'événement métier (Meta, candidatures ODC,
  opportunités...).
- **Un événement in-process découplé (`@nestjs/event-emitter`)** — retenu.
  `AuditsService` n'a plus besoin de connaître `OpsAutomationModule` du
  tout ; `AuditCompletedEventListener` vit dans `OpsAutomationModule`, qui
  a déjà accès à `AutomationsService` en interne. Tout futur émetteur
  réutilise le même schéma sans jamais recréer ce problème.

`EventEmitterModule.forRoot()` est enregistré une seule fois, globalement,
dans `AppModule` — aucun autre module n'a besoin de l'importer pour
utiliser `EventEmitter2`.

Note de version : `@nestjs/event-emitter@12.x` est publié en pur ESM
(`"type": "module"`), ce qui casse la compilation Jest de ce repo (CommonJS,
aucun changement de config Jest fait ici). `@nestjs/event-emitter@3.1.0`
(dernière version CJS, compatible peer `@nestjs/core@^11`) est utilisé à la
place — aucune limitation fonctionnelle pour cet usage.

## Garanties

- **Aucune régression RC14/RC20/RC21** : `AutomationsService.emitEvent()`
  et `getOrCreateEvent()` ne sont pas modifiés ; `AuditsService` gagne
  uniquement une dépendance supplémentaire (`EventEmitter2`) et un appel
  `.emit()` après chaque écriture `status: 'completed'` existante.
- **Aucun nouveau modèle Prisma.**
- **Aucun scheduler cron** : confirmé qu'aucune dépendance
  `@nestjs/schedule` n'existe et qu'aucun code n'exécute
  `Automation.trigger.cronExpression` — chantier séparé, plus important,
  hors-scope ici.
- **Isolation organisation** : `emitEvent(organizationId, ...)` ne cherche
  que les automations de CETTE organisation (garanti par RC20, re-vérifié
  ici avec un cas concret `audit.completed`).
- **Idempotence** : `eventKey = audit.id` — deux complétions du même audit
  (retry) ne créent jamais deux événements ni deux runs (dédup RC-20 sur
  `(organizationId, eventType, eventKey)`).
- **`globalScore` jamais fabriqué** : `null` pour `runSite()` (qui ne le
  calcule pas), la vraie valeur pour `run()` — jamais un `0` de repli.
- **Résilience** : une panne d'Ops Automation (DB indisponible, bug futur)
  ne fait jamais échouer `POST /audits/run`/`run-site` — le listener avale
  toute erreur, et `EventEmitter2.emit()` n'est jamais attendu par
  `AuditsService`.

## Fichiers modifiés / créés

**Créés** :
- `src/audits/audit-completed.event.ts` — contrat de l'événement in-process.
- `src/ops-automation/audit-completed-event.listener.ts` — le pont vers
  `AutomationsService.emitEvent()`.
- `src/ops-automation/audit-completed-event.listener.spec.ts` — tests du
  listener (payload transmis, `null` préservé, panne d'ingestion avalée).
- `src/ops-automation/audit-completed-event.wiring.spec.ts` — preuve que
  le décorateur `@OnEvent` est réellement câblé (compile un vrai
  `EventEmitterModule.forRoot()` + le listener, émet un vrai événement).
- `docs/RC23_OPS_AUTOMATION_EVENT_WIRING.md` — ce document.

**Modifiés** :
- `src/audits/audits.service.ts` — injecte `EventEmitter2`, émet
  `audit.completed` sur les deux chemins de complétion (`run()`,
  `runSite()`).
- `src/ops-automation/ops-automation.module.ts` — enregistre
  `AuditCompletedEventListener` comme provider.
- `src/app.module.ts` — importe `EventEmitterModule.forRoot()`.
- `src/audits/audits.service.spec.ts` — nouveaux tests d'émission
  d'événement (succès/échec, `run`/`runSite`) ; mocks mis à jour avec le
  5ᵉ paramètre du constructeur.
- `src/ops-automation/automations.service.spec.ts` — nouveau test
  d'isolation multi-tenant spécifique à `audit.completed`.
- `src/multi-tenant-isolation.spec.ts`, `src/organization-isolation.spec.ts`
  — mocks `AuditsService` mis à jour avec le 5ᵉ paramètre.
- `package.json` — ajoute `@nestjs/event-emitter@^3.1.0`.

## Tests exécutés

```
npx jest --silent                    → 53 suites, 327 tests, tous passants
                                        (319 pré-existants + 8 nouveaux)
npx tsc --noEmit -p tsconfig.json    → aucune nouvelle erreur (1 erreur
                                        pré-existante et sans rapport dans
                                        n8n-webhook.service.spec.ts, fichier
                                        non touché par RC23)
npx eslint <fichiers RC23>           → 0 nouvelle erreur (baseline
                                        pré-existante de audits.service.spec.ts
                                        et organization-isolation.spec.ts
                                        inchangée, vérifiée ligne à ligne
                                        contre le head pré-RC23)
npm run build                        → prisma generate + nest build : succès
```

`npm audit` : le compte de vulnérabilités passe de 18 à 19 en apparence,
mais il ne s'agit pas d'un nouveau paquet vulnérable — `@nestjs/event-
emitter` dépend simplement de `@nestjs/core`, déjà signalé vulnérable dans
la chaîne pré-existante `@nestjs/platform-express`/`multer`/`@nestjs/core`
(déjà déférée à une tâche de hardening séparée, non touchée ici).

## Ce qui reste hors-scope (pour un RC futur)

- Modèle de données candidature/dossier ODC.
- Événement `candidature.reçue` et tout workflow ODC.
- Notifications email/SMS réelles.
- Scheduler cron / exécution de `Automation.trigger.cronExpression`.
- Tout autre événement métier (`opportunity.created`, futurs événements
  Meta) — à ajouter au fur et à mesure, en réutilisant exactement le même
  schéma (`EventEmitter2.emit()` côté émetteur + un listener dédié côté
  `ops-automation`).
