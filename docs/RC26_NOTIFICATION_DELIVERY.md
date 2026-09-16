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
                  - valide templateKey/templateData (notification-templates.ts)
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
SMTP_PORT=
SMTP_SECURE=true
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=
SMTP_FROM_NAME=
```

Distinctes des `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USERNAME`/
`SMTP_PASSWORD`/`SMTP_FROM` déjà utilisées par
`PasswordResetMailService` — peuvent pointer vers le même serveur en
pratique, mais configurées séparément (identifiants dédiés possibles,
jamais partagés en code).

## Procédure d'activation

1. Configurer `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/
   `SMTP_PASSWORD`/`SMTP_FROM_EMAIL`/`SMTP_FROM_NAME`, `NOTIFICATIONS_ENABLED`
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
- `POST /ops/notifications/:id/retry` : uniquement depuis `dead_letter`,
  remet en `pending` sans créer de nouvelle ligne, conserve
  `idempotencyKey` et `attemptCount` (un retry manuel n'accorde pas un
  nouveau budget de 5 tentatives — s'il échoue à nouveau, il repart direct
  en `dead_letter`).

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
| `audit_completed` | `websiteUrl`, `globalScore` |
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

## Exemple fourni, désactivé

`src/ops-automation/examples/automation-examples.ts` — « Notifier par email
la fin d'un audit » (`audit.completed` → `robia.notification.send_email`,
`templateKey: audit_completed`). `enabled: false` comme les 3 exemples
RC-20 existants ; rien dans ce dépôt ne l'active automatiquement. Ne doit
être activé qu'après configuration et validation manuelle du canal SMTP
(voir « Procédure d'activation »).

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
- `.env.production.example` — nouvelles variables SMTP dédiées (aucune
  valeur réelle).

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

## Tests exécutés

```
npx jest --silent                    → 61 suites, 437 tests, tous passants
npx tsc --noEmit -p tsconfig.json    → aucune nouvelle erreur (1 erreur
                                        pré-existante et sans rapport,
                                        documentée depuis RC23)
npx eslint "{src,apps,libs,test}/**/*.ts" --format json
  --output-file eslint-report.json
node scripts/check-eslint-baseline.mjs
  eslint-report.json 74 23           → ESLint debt: 74 errors, 23 warnings
                                        (baseline: 74/23) — aucune hausse
npm run build                        → prisma generate + nest build : succès
sh -n deploy/github-deploy.sh        → syntaxe shell OK
python -m unittest discover
  -s deploy/tests -p "test_*.py"     → 22 tests, tous passants
docker compose -f docker-compose.production.yml
  config --quiet                     → configuration valide
```
