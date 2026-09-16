# RC26 — Notification Delivery Foundation

Ajoute un véritable canal email aux automatisations RC20 : un nouveau
`NotificationDelivery` persistant, un dispatcher périodique qui l'envoie
réellement par SMTP (via Nodemailer), avec reprises, dead-letter et suivi
opérationnel — le tout gardé inerte tant que le canal n'est pas configuré et
activé explicitement.

## Ce qui existait déjà, et n'a pas changé

- Le moteur RC20 (`AutomationsService.startRun()`/`executeSteps()`) —
  aucun second moteur d'exécution.
- Le registre d'actions allowlisté RC20
  (`OpsActionsRegistryService`) — RC26 y ajoute une action de plus,
  `robia.notification.send_email`, selon exactement le même schéma
  (`inputSchema` + validation + `execute()`) que les 4 actions existantes.
- Le dispatcher RC25 (`AutomationSchedulerService`) — RC26 en réutilise le
  patron de réclamation en deux phases avec bail, appliqué ici à
  `NotificationDelivery.claimedAt` plutôt qu'à `Automation.nextRunAt`.

## Architecture

```
AutomationRun (RC-20, inchangé)
  → executeSteps()
      → step.actionType === 'robia.notification.send_email'
          → OpsActionsRegistryService.execute(..., context)
              context = { automationId, runId, stepRunId }  // jamais dérivé
                                                              // de l'input
              → NotificationsService.createEmailDelivery()
                  - templateKey === 'audit_completed' : templateData n'est
                    JAMAIS pris depuis l'input du step (voir « Résolution
                    audit_completed » plus bas) — résolu depuis la table
                    Audit, org-scopé
                  - sinon : valide templateData tel que fourni
                    (notification-templates.ts)
                  - résout le destinataire : Automation.createdById → User.email
                    (jamais une adresse fournie par l'appelant)
                  - vérifie automation.organizationId === organizationId
                    ET organization.ownerId === automation.createdById
                  - crée une NotificationDelivery (status: pending),
                    idempotencyKey = `automation-step:${stepRunId}`
              ← { deliveryId, channel, templateKey, status, recipientMasked }
                (preuve retournée comme evidence du step — jamais l'adresse
                complète)

NotificationDispatcherService (nouveau, indépendant)
  @Cron(EVERY_MINUTE) handleTick()
    → runDueDeliveries(now)
        → transport.ensureReady()  // NOTIFICATIONS_ENABLED + config SMTP,
                                    // aucun réseau si ça lève
        → SELECT deliveries WHERE (status IN (pending, retry_scheduled)
                                    AND next_attempt_at <= now)
                                OR status = processing
                               AND (claimed_at IS NULL OR claimed_at < stale)
        → pour chaque livraison due : réclamation en deux phases (voir plus
          bas), puis SmtpNotificationTransport.sendEmail() via un template
          rendu à l'instant (notification-templates.ts, jamais mis en cache)
```

Créer une `NotificationDelivery` n'envoie jamais rien par elle-même — seul
`NotificationDispatcherService`, sur son propre cycle, tente réellement
l'envoi.

## Cycle de statuts

```
pending ──────────────┐
                       ▼
            ┌──► processing ──► sent (terminal)
            │        │
            │        ├──► retry_scheduled ──(nextAttemptAt atteint)──┐
            │        │                                                │
retry_scheduled ◄─────┘                                                │
            │                                                          │
            └──────────────────────────────────────────────────────────┘
                       │
                       └──► dead_letter (terminal, sauf retry manuel)
                                  │
                                  └──(POST .../retry)──► pending
```

- `pending` : créée, jamais encore réclamée.
- `processing` : réclamée par une instance du dispatcher — visible côté ops
  pendant l'envoi ; si le processus plante ici, la ligne y reste jusqu'à
  expiration du bail (`claimedAt`), puis une autre instance la reprend.
- `retry_scheduled` : un échec temporaire a programmé une nouvelle tentative
  à `nextAttemptAt` (voir « Reprises et dead-letter »).
- `sent` : SMTP a accepté le message — `providerMessageId` et `sentAt`
  renseignés, `lastError` réinitialisé.
- `dead_letter` : échec permanent, ou nombre maximal de tentatives atteint.
  Seul état à partir duquel `POST /ops/notifications/:id/retry` est accepté.

## Réclamation en deux phases avec bail (concurrence multi-instance)

Même schéma que `AutomationSchedulerService` (RC25), avec un ajustement :
puisque `processing` est un état visible et persistant (pas seulement un
bail interne), le due-set et la réclamation matchent aussi une ligne déjà en
`processing` dont le bail est périmé — ce qui permet la reprise après
plantage, décrite ci-dessous.

1. **Claim** : `UPDATE notification_deliveries SET status = 'processing',
   claimed_at = now WHERE id = ? AND (<due> OR status = 'processing') AND
   (claimed_at IS NULL OR claimed_at < now - LEASE_MS)`. Postgres sérialise
   deux `UPDATE` concurrents sur la même ligne : le perdant relit une valeur
   déjà modifiée par le gagnant, son `WHERE` ne matche plus, `count = 0`.
2. **Relecture** : confirme que cet appel détient bien le bail qu'il vient
   de gagner (`status === 'processing' && claimedAt === now`) avant de
   toucher à quoi que ce soit d'autre.
3. **Envoi** : via `NotificationTransport` (SMTP aujourd'hui).
4. **Finalisation** : chaque écriture terminale (`sent` /
   `retry_scheduled` / `dead_letter`) inclut `claimedAt: now` dans son
   propre `WHERE` — un worker resté bloqué au-delà de la durée du bail, et
   dont la réclamation a depuis été reprise par une autre instance, ne peut
   ni libérer ni écraser le résultat de cette autre instance.

**Reprise après plantage** : si le processus plante entre la Phase 1 et la
Phase 4, la ligne reste `status: 'processing'` avec un `claimedAt` de plus
en plus périmé. Le tick suivant (sur cette instance ou une autre) la
retrouve via la branche `status = 'processing'` du due-set, dès que le bail
a expiré (`SCHEDULED_CLAIM_LEASE_MS`, 5 minutes), et la retraite avec le
même `id`/`idempotencyKey` — jamais une nouvelle ligne.

## Idempotence

`idempotencyKey = automation-step:${automationStepRunId}` — `stepRunId` est
déjà unique par exécution de step (une seule fois par run, RC-20 ne
ré-exécute jamais un step). Contrainte unique
`(organizationId, idempotencyKey)` : un appel répété de
`createEmailDelivery()` pour le même run/step (rejeu, ou tout futur
mécanisme de reprise au niveau step) renvoie toujours la même ligne, jamais
une seconde livraison — même schéma de re-lecture-sur-conflit (P2002) que
`AutomationsService.persistRun()`.

## Variables SMTP

```
NOTIFICATIONS_ENABLED=false   # tant que ce n'est pas exactement "true",
                               # aucune connexion réseau n'est jamais tentée
SMTP_HOST=
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM=
```

**Revue RC-26, point 5 (fix) :** ce sont exactement les mêmes noms de
variables que `PasswordResetMailService` (`SMTP_HOST`/`SMTP_PORT`/
`SMTP_SECURE`/`SMTP_USERNAME`/`SMTP_PASSWORD`/`SMTP_FROM`), lues telles
quelles par `SmtpNotificationTransport` — mêmes valeurs par défaut
(`SMTP_PORT` → `'465'`, `SMTP_SECURE` → `'true'`, `SMTP_FROM` → nom
d'utilisateur), même format d'expéditeur (`ROBIA Copilot <...>`). La
version précédente de cette PR déclarait un second jeu de variables
(`SMTP_USER`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`) redondant avec
l'existant ; corrigé pour ne jamais faire coexister deux configurations
SMTP. Un test dédié
(`smtp-notification-transport.service.spec.ts`, « reads exactly the same
SMTP_* variable names as PasswordResetMailService, never a duplicate
set ») garantit qu'aucune variable dupliquée ne peut être réintroduite
sans faire échouer la suite.

## Procédure d'activation

1. Configurer `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USERNAME`/
   `SMTP_PASSWORD`/`SMTP_FROM` (déjà en place pour
   `PasswordResetMailService` en pratique), `NOTIFICATIONS_ENABLED`
   restant à `false`.
2. Redéployer : `SmtpNotificationTransport.ensureReady()` ne lève déjà plus
   `IncompleteSmtpConfigurationError`, mais `NOTIFICATIONS_ENABLED=false`
   empêche encore tout envoi — aucune régression possible pendant cette
   étape.
3. Passer `NOTIFICATIONS_ENABLED=true` et redéployer.
4. Valider manuellement (voir « Procédure de test contrôlé en production »)
   avant d'activer la moindre automation réelle utilisant
   `robia.notification.send_email`.
5. Aucune automation n'est activée par défaut par RC26 — voir « Exemple
   fourni, désactivé » plus bas.

## Reprises et dead-letter

- Maximum **5 tentatives**. Backoff : 1 min, 5 min, 30 min, 2 h, 12 h.
- La tentative n°1 n'a pas de délai (elle part dès qu'elle est due) ; seules
  4 reprises suivent (donc 4 des 5 délais de backoff sont réellement
  consommés), avant que la 5ᵉ tentative — si elle échoue aussi — parte
  directement en `dead_letter`. Le 5ᵉ délai (12 h) est conservé dans le code
  par symétrie avec la spécification et pour un futur relèvement du
  plafond ; il n'est pas atteint sous la limite actuelle.
- Erreur temporaire (réseau, timeout, SMTP 4xx, ou toute erreur non
  reconnue) → `retry_scheduled`.
- Erreur permanente (SMTP 5xx, adresse structurellement invalide, template
  qui ne peut plus se rendre) → `dead_letter` immédiat, sans consommer les
  tentatives restantes inutilement.

  **Revue RC-26, point 4 (fix) — compteur de tentatives incorrect :** la
  première version incrémentait `attemptCount` seulement sur échec
  (`markDeadLetter()`/`scheduleRetryOrDeadLetter()`), jamais sur succès —
  un premier envoi réussi affichait `attemptCount: 0` — et une tentative
  interrompue par un crash entre la réclamation et la finalisation n'était
  jamais comptée du tout. Corrigé en déplaçant l'incrément dans la Phase 1
  (réclamation) elle-même, via l'opérateur atomique Prisma
  `{ increment: 1 }` sur le même `UPDATE` qui pose `status: 'processing'`
  — donc compté dès la réclamation, que l'issue soit un succès, un échec,
  ou un crash avant toute finalisation. Les écritures terminales
  (`sent`/`retry_scheduled`/`dead_letter`) lisent désormais
  `delivery.attemptCount` tel quel (déjà post-incrément), sans y rajouter
  `+1`. Testé explicitement : un premier succès affiche `attemptCount: 1`
  ; une tentative interrompue par un crash (réclamée mais jamais finalisée)
  affiche déjà `attemptCount: 1` pendant qu'elle est encore `processing`.
- `POST /ops/notifications/:id/retry` : uniquement depuis `dead_letter`,
  remet en `pending` sans créer de nouvelle ligne, conserve
  `idempotencyKey` et `attemptCount` (un retry manuel n'accorde pas un
  nouveau budget de 5 tentatives — s'il échoue à nouveau, il repart direct
  en `dead_letter`).

  **Revue RC-26, point 3 (fix) — course concurrente sur le retry :** la
  première version lisait le statut (`findOne()`) puis écrivait
  (`update()`) sans condition sur l'état courant au moment de l'écriture ;
  deux requêtes de retry concurrentes, ou un retry courant contre le
  dispatcher (qui venait de reprendre la livraison après expiration du
  bail), pouvaient toutes deux passer le contrôle de lecture puis toutes
  deux écrire, la seconde écrasant silencieusement ce que la première — ou
  le worker — avait déjà fait, y compris réinitialiser `claimedAt` sous un
  envoi en cours. Corrigé : `retry()` utilise désormais un `updateMany`
  conditionnel unique, gated sur `status IN (dead_letter)` **au moment de
  l'écriture**, jamais un `update()` inconditionnel après lecture. Si
  `count === 0` (l'état a changé entre temps), `NotificationRetryNotAllowedError`
  (409) est levée plutôt que de laisser croire que le retry a réussi. Testé
  via un mock qui fait basculer le statut entre la lecture et l'écriture.

## Risque résiduel : pas d'exactly-once SMTP

Si le fournisseur SMTP accepte le message puis que le processus plante
avant que l'écriture `status: 'sent'` ne commite, la reprise (après
expiration du bail) renverra le même email une seconde fois — SMTP
lui-même n'offre aucune garantie d'idempotence côté fournisseur (pas de
`Message-ID` déduplicable de façon fiable côté réception). Ce document
l'assume explicitement : RC26 ne prétend pas garantir l'exactly-once
externe, seulement l'absence de perte et l'absence de double *tentative*
concurrente (deux instances ne peuvent jamais envoyer simultanément la même
livraison).

## Suivi opérationnel

- `GET /ops/notifications` — liste, plus récent d'abord, isolée par
  organisation (`JwtAuthGuard` + `OrgScopeGuard`, même patron que
  `/ops/automations`).
- `GET /ops/notifications/:id` — détail, 404 si hors organisation.
- `POST /ops/notifications/:id/retry` — voir « Reprises et dead-letter ».

Jamais exposé : `SMTP_PASSWORD`, tout détail interne du transport, ou
l'adresse complète du destinataire — `recipientMasked` (`j***@example.com`)
partout, y compris dans l'evidence du step RC-20 et dans les logs du
dispatcher.

Pas de frontend dans cette PR — voir « Plan frontend minimal » plus bas.

## Action RC-20 : `robia.notification.send_email`

- `inputSchema: ['templateKey']`, `objectInputFields: ['templateData']` —
  aucun champ `to`/`recipient`/`replyTo`/`subject`/`body`/`html` n'est
  déclaré : tout champ de ce type dans l'input d'un step est silencieusement
  supprimé par `canonicalizeInput()`, jamais transmis à l'action.
- Le destinataire est résolu exclusivement via le `context` d'exécution
  trusted (`automationId` → `Automation.createdById` → `User.email`),
  jamais depuis l'input du step.
- Templates allowlistés uniquement (`audit_completed`, `automation_failed`,
  `weekly_opportunities_summary`) — voir `notification-templates.ts`.

## Templates

Texte brut, rendu server-side uniquement. Chaque template déclare son
propre ensemble exact de variables :

| Clé | Variables |
|---|---|
| `audit_completed` | `websiteUrl`, `scoreLine` |
| `automation_failed` | `automationName`, `errorMessage` |
| `weekly_opportunities_summary` | `organizationName`, `openOpportunityCount` |

Validation stricte (`notification-templates.ts`) : variable inconnue
rejetée, variable manquante rejetée, valeur limitée à 200 caractères,
caractère de saut de ligne (`\r`/`\n`) rejeté (protection contre
l'injection d'en-têtes, puisque chaque variable est aussi substituée dans
le sujet). `robia.notification.send_email` place `templateData` derrière
`objectInputFields` (extension RC-26 de `OpsActionsRegistryService`) plutôt
que `inputSchema`, puisque c'est un objet structuré et non une simple
chaîne — voir son propre commentaire dans
`ops-actions-registry.service.ts`.

`AutomationsService.automation-templating.ts` a été étendu (RC-26) pour
résoudre un placeholder `{{event.<key>}}` sur **un niveau** d'objet imbriqué
(pas seulement au premier niveau d'`input`), afin que `templateData` puisse
recevoir des valeurs issues de l'événement déclencheur — voir son propre
commentaire pour la justification de la limite à un seul niveau.

## Résolution `audit_completed` (revue RC-26, point 1 — fix)

L'événement réel `audit.completed` (voir
`src/audits/audit-completed.event.ts`) transporte uniquement
`{ organizationId, auditId, websiteId, globalScore }` — jamais de
`websiteUrl`, et `globalScore` peut être `null` (« jamais fabriqué »,
selon son propre commentaire). La première version de cette PR attendait
`event.websiteUrl` dans `templateData`, ce qui ne pouvait jamais
fonctionner avec l'événement réel et aurait fait rejeter la livraison par
la validation de template.

Corrigé : pour `templateKey === 'audit_completed'` uniquement,
`NotificationsService.resolveTemplateData()` ignore tout `templateData`
fourni par le step et résout les données lui-même, à partir de l'audit :

- `auditId` devient un champ dédié de l'action (`optionalInputSchema`,
  jamais `objectInputFields`/`templateData`), résolu via
  `{{event.auditId}}` dans l'exemple fourni.
- `NotificationAuditResolutionError` (jamais surfacée en HTTP, seulement
  consommée par `executeSteps()`) si `auditId` est absent, ou si l'audit
  n'existe pas / n'appartient pas à `organizationId` — contrôle
  d'organisation systématique, jamais un audit d'une autre organisation.
- `websiteUrl` vient de `audit.website.url` (relation Prisma).
- Un score absent (`audit.globalScore === null`) est traité explicitement
  : la variable de template n'est plus le nombre brut `globalScore` mais
  une chaîne déjà formatée `scoreLine` (`"82/100"` ou `"non disponible"`),
  calculée une seule fois côté serveur — le template lui-même ne
  distingue jamais un score présent d'un score absent.

## Dédoublonnage avec l'email n8n existant (revue RC-26, point 2 — fix)

Un chemin d'envoi d'email « audit terminé » existait déjà, indépendamment
de RC-26 : `OpportunitiesService.generateFromAudit()` (appelée par
l'automation d'exemple RC-20 pré-existante « Régénérer les opportunités
après un audit terminé », elle-même déclenchée par `audit.completed`)
déclenche inconditionnellement `this.webhooks.notifyAuditCompleted(...)`
(n8n) en effet de bord dès que des opportunités sont générées. La
première version de cette PR ajoutait un second chemin SMTP sans toucher
à celui-ci — une fois l'exemple RC-26 activé, un audit terminé aurait pu
déclencher les deux emails, la déduplication par `automationStepRunId`
ne couvrant que l'intérieur d'un seul chemin, pas les deux entre eux.

Corrigé : `NOTIFICATIONS_ENABLED` est lui-même le bascule de
responsabilité unique. `OpportunitiesService.generateFromAudit()`
n'appelle `notifyAuditCompleted()` (n8n) que si
`NOTIFICATIONS_ENABLED !== 'true'` (comportement inchangé aujourd'hui,
puisque la valeur par défaut est `false`). Une fois basculé à `true`
(après validation manuelle du canal RC-26, voir « Procédure d'activation
»), le chemin n8n s'arrête et seul l'exemple `robia.notification.send_email`
(activé séparément, explicitement) devient la source d'email d'audit —
jamais les deux à la fois, sans étape de coordination manuelle
supplémentaire.

## Exemple fourni, désactivé

`src/ops-automation/examples/automation-examples.ts` — « Notifier par email
la fin d'un audit » (`audit.completed` → `robia.notification.send_email`,
`templateKey: audit_completed`, `auditId: '{{event.auditId}}'`, jamais de
`templateData` statique — voir « Résolution audit_completed » ci-dessus).
`enabled: false` comme les 3 exemples RC-20 existants ; rien dans ce
dépôt ne l'active automatiquement. Ne doit être activé qu'après
configuration et validation manuelle du canal SMTP (voir « Procédure
d'activation ») **et** confirmation que `NOTIFICATIONS_ENABLED=true` a
bien coupé le chemin n8n existant (voir « Dédoublonnage » ci-dessus).

## Procédure de test contrôlé en production

1. `NOTIFICATIONS_ENABLED=true`, SMTP configuré (voir plus haut).
2. Créer une automation de test, `requiresApproval: true`,
   `robia.notification.send_email` avec `templateKey: audit_completed` et
   un `templateData` de test, adressée au compte de l'opérateur qui teste
   (le créateur de l'automation est toujours le destinataire).
3. Déclencher manuellement (`POST /ops/automations/:id/run`), approuver le
   run — la `NotificationDelivery` passe en `pending`.
4. Attendre le tick suivant (≤ 1 min) ou surveiller
   `GET /ops/notifications/:id` jusqu'à `sent`.
5. Vérifier la réception réelle de l'email, puis désactiver/supprimer
   l'automation de test.
6. Ne jamais activer une automation réelle utilisant ce canal avant d'avoir
   complété cette procédure au moins une fois sur l'environnement cible.

## Plan frontend minimal (RC futures)

Hors scope de cette PR — plan séparé à fournir après validation du backend :
écran `/ops/notifications` (liste + détail + bouton retry, réutilisant les
patrons déjà en place pour `/ops/automations`), jamais l'adresse complète
affichée, jamais de configuration SMTP éditable depuis l'UI (reste
env-only).

## Fichiers créés

- `prisma/migrations/20260916120000_add_notification_deliveries/`
- `src/notifications/notification-templates.ts` (+ `.spec.ts`)
- `src/notifications/notification-transport.ts`
- `src/notifications/smtp-notification-transport.service.ts` (+ `.spec.ts`)
- `src/notifications/mask-email.ts` (+ `.spec.ts`)
- `src/notifications/notifications.service.ts` (+ `.spec.ts`)
- `src/notifications/notification-dispatcher.service.ts` (+ `.spec.ts`)
- `src/notifications/notifications.controller.ts` (+ `.spec.ts`)
- `src/notifications/dto/notification-delivery.dto.ts`
- `src/notifications/notifications.module.ts`
- `docs/RC26_NOTIFICATION_DELIVERY.md`

## Fichiers modifiés

- `prisma/schema.prisma` — `NotificationDelivery` + relations inverses
  (`Organization`, `User`, `AutomationRun`, `AutomationStepRun`).
- `src/ops-automation/actions/ops-actions-registry.service.ts` —
  `OpsActionExecutionContext` (automationId/runId/stepRunId, trusted,
  jamais dérivé de l'input) ; `objectInputFields` sur
  `OpsActionDescriptor`/`canonicalizeInput()` ; nouvelle action
  `robia.notification.send_email`.
- `src/ops-automation/automations.service.ts` — `executeSteps()` passe le
  contexte d'exécution à `actionsRegistry.execute()`.
- `src/ops-automation/automation-templating.ts` — résolution
  `{{event.<key>}}` sur un niveau d'objet imbriqué.
- `src/ops-automation/examples/automation-examples.ts` — 4ᵉ exemple
  (désactivé).
- `src/ops-automation/ops-automation.module.ts` /
  `src/app.module.ts` — enregistrent `NotificationsModule`.
- `.env.production.example` — plus de second jeu de variables SMTP ;
  seule `NOTIFICATIONS_ENABLED=false` ajoutée (réutilise les variables
  SMTP existantes de `PasswordResetMailService`, double aussi de bascule
  pour le dédoublonnage n8n — voir « Variables SMTP » et « Dédoublonnage
  »).
- `src/opportunities/opportunities.service.ts` — `generateFromAudit()`
  ne déclenche plus `notifyAuditCompleted()` (n8n) que si
  `NOTIFICATIONS_ENABLED !== 'true'` (voir « Dédoublonnage »).

## Dépendances

`nodemailer@^9.1.1` (+ `@types/nodemailer`) — déjà présentes dans
`package.json` (utilisées par `PasswordResetMailService`), aucune nouvelle
dépendance ajoutée par RC26. CommonJS, confirmé compatible Jest (import
`import nodemailer from 'nodemailer'`, même style que l'usage existant).

## Ce qui reste hors-scope (RC futures)

- Frontend `/ops/notifications` (voir « Plan frontend minimal »).
- Canaux autres qu'email (SMS, push, Slack...).
- Retries automatiques au niveau step RC-20 lui-même (distinct des retries
  de livraison de ce document).

## Corrections de revue (deuxième tour)

Codex/l'utilisateur a identifié 5 défauts bloquants avant fusion,
documentés chacun à leur section respective ci-dessus :

1. **Résolution `audit_completed`** — l'exemple fourni ne pouvait pas
   fonctionner avec l'événement réel (`event.websiteUrl` n'existe pas) ;
   corrigé par une résolution server-side depuis `Audit`, org-scopée,
   avec un score absent traité explicitement.
2. **Dédoublonnage n8n/SMTP** — `NOTIFICATIONS_ENABLED` devient la
   bascule de responsabilité unique pour l'email d'audit.
3. **Course concurrente sur le retry** — `updateMany` conditionnel gated
   sur `status` au moment de l'écriture, jamais un `update()`
   inconditionnel après lecture.
4. **Compteur de tentatives incorrect** — incrémenté atomiquement à la
   réclamation (Phase 1), jamais seulement sur échec.
5. **Configuration SMTP dupliquée** — plus aucun nom de variable propre à
   RC-26 ; réutilise exactement `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/
   `SMTP_USERNAME`/`SMTP_PASSWORD`/`SMTP_FROM` de `PasswordResetMailService`.

## Tests exécutés

```
npx jest --silent                    → 61 suites, 451 tests, tous passants
npx tsc --noEmit -p tsconfig.json    → aucune nouvelle erreur (1 erreur
                                        pré-existante et sans rapport,
                                        documentée depuis RC23)
npx eslint "{src,apps,libs,test}/**/*.ts" --format json
  --output-file eslint-report.json
node scripts/check-eslint-baseline.mjs
  eslint-report.json 74 23           → ESLint debt: 74 errors, 23 warnings
                                        (baseline: 74/23) — aucune hausse
npm run build                        → prisma generate + nest build : succès
python -m unittest discover
  -s deploy/tests -p "test_*.py"     → 22 tests, tous passants
docker compose -f docker-compose.production.yml
  config --quiet                     → configuration valide
```
