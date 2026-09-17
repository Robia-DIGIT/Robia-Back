# RC26 — Notification Delivery Foundation

## Périmètre et compatibilité

RC26 ajoute une file persistante de notifications aux actions RC20, avec transport
SMTP, reprises bornées et endpoints de suivi. Nodemailer et le compte SMTP de
PasswordResetMailService sont réutilisés. Aucun nouveau fournisseur ni secret.

L'email d'audit existant reste envoyé par n8n, après génération des opportunités,
avec son contenu actuel. Sa migration est différée : elle exige un workflow
ordonné « générer les opportunités → envoyer » ou un événement
`opportunities.generated`. Cette PR n'active aucune automation ni migration.

## Deux réglages indépendants

```dotenv
NOTIFICATIONS_ENABLED=false
AUDIT_COMPLETED_EMAIL_PROVIDER=n8n
```

- `NOTIFICATIONS_ENABLED` active uniquement le dispatcher SMTP générique.
- `AUDIT_COMPLETED_EMAIL_PROVIDER` choisit le responsable de l'email d'audit.
  Seules les valeurs exactes `n8n` et `notifications` sont reconnues.
  Une valeur absente donne `n8n`. Une valeur invalide donne également `n8n`,
  avec un avertissement fixe qui n'affiche jamais la valeur reçue.
- La décision de routage est partagée entre OpportunitiesService et
  NotificationsService pour éviter deux interprétations différentes.

| Dispatcher | Fournisseur audit | Comportement |
|---|---|---|
| désactivé | n8n | email n8n conservé ; pas de livraison SMTP audit |
| activé | n8n | email n8n conservé ; notifications génériques disponibles |
| activé | notifications | email n8n coupé ; livraison audit RC26 si une automation l'exécute |
| désactivé | notifications | email n8n coupé ; livraisons RC26 en attente, sans envoi |

La dernière configuration suspend volontairement le canal choisi : ne pas
l'utiliser pour cette livraison. Conserver `n8n` dans tous les environnements
jusqu'à validation séparée de la migration. Choisir `notifications` ne crée et
n'active aucune automation. Il faut un producteur opérationnel avant toute bascule.

En mode `n8n`, l'action RC20 `audit_completed` retourne une preuve
`status: skipped, reason: handled_by_n8n`, sans créer de NotificationDelivery
ni appeler SMTP. Cette preuve exprime le routage, pas une confirmation de
réception ou d'envoi par n8n. Le run RC20 peut réussir puisque l'action de routage
a été traitée.

## Architecture

L'action `robia.notification.send_email` reçoit le contexte serveur
`automationId/runId/stepRunId`. Elle résout le destinataire depuis
Automation.createdById, vérifie l'organisation et son propriétaire, puis crée
une NotificationDelivery. Aucun destinataire, corps, sujet ou header libre.

Une clé unique `(organizationId, automation-step:stepRunId)` évite de créer
deux livraisons pour la même étape. Cette clé ne déduplique pas deux automations
distinctes ni les anciens emails n8n.

Pour `audit_completed`, `auditId` est obligatoire en mode notifications :
les données sont relues depuis Audit avec filtre d'organisation. Le score absent
devient « non disponible ». L'événement RC23 fournit auditId et websiteId,
pas websiteUrl. Les données du template audit ne viennent pas de l'utilisateur.

Templates texte disponibles :

| Template | Entrée |
|---|---|
| audit_completed | auditId ; URL et score résolus côté serveur |
| automation_failed | templateData : automationName, errorMessage |
| weekly_opportunities_summary | templateData : organizationName, openOpportunityCount |

Les variables sont validées, limitées à 200 caractères et sans retour à la ligne.
Les événements d'échec et les calculs de résumés ne sont pas automatiquement
branchés par la simple existence de ces templates.

## Dispatcher, concurrence et tentatives

Un tick chaque minute sélectionne les livraisons dues. Une mise à jour
conditionnelle réclame la livraison, pose un bail de cinq minutes et incrémente
atomiquement attemptCount. Le worker relit son bail avant l'envoi et utilise
ce bail comme condition de finalisation.

Statuts : pending → processing → sent, retry_scheduled ou dead_letter.
Un bail expiré permet la récupération après crash. Une livraison due avec
attemptCount >= 5 passe atomiquement en dead_letter sans nouvelle réclamation,
sans incrément et sans appel au transport. Une cinquième tentative dont le bail
est encore valide n'est pas interrompue. La réclamation exige elle-même
attemptCount < 5 pour fermer la course avec la vérification du plafond.

Maximum cinq tentatives au total, crashs compris. Délais des quatre reprises :
1 minute, 5 minutes, 30 minutes, 2 heures. Les erreurs SMTP temporaires/réseau
sont réessayées ; les erreurs permanentes sont placées en dead_letter.

Le retry manuel n'accorde aucun nouveau budget : uniquement depuis dead_letter
avec attemptCount < 5, contrôlés ensemble par une mise à jour atomique.
À cinq tentatives, réponse 409 ; l'historique et le compteur sont conservés.
Un nouveau cycle au-delà du plafond n'est pas proposé par cette version.

L'acceptation SMTP signifie « accepté par le serveur », pas « reçu dans la boîte
du destinataire ». Après acceptation puis crash avant enregistrement du succès,
un doublon reste possible. Aucun exactly-once externe n'est garanti.
Les baux évitent les réclamations simultanées ordinaires ; ils ne constituent
pas un verrou sur un fournisseur externe lorsqu'un worker reste bloqué au-delà
du bail. Les délais SMTP sont bornés, mais ce risque résiduel doit rester explicite.

## Configuration SMTP existante

```dotenv
SMTP_HOST=
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM=
```

Même configuration que PasswordResetMailService ; SMTP_FROM retombe sur
SMTP_USERNAME, SMTP_PORT sur 465 et SMTP_SECURE sur true. Aucun SMTP_USER,
SMTP_FROM_EMAIL ou SMTP_FROM_NAME supplémentaire.

Lorsque NOTIFICATIONS_ENABLED n'est pas exactement true, le dispatcher ne
réclame rien et n'ouvre aucune connexion. Les livraisons génériques déjà créées
restent en attente. Les secrets et adresses sont nettoyés dans les logs/preuves.

## Test contrôlé du canal générique

1. Conserver AUDIT_COMPLETED_EMAIL_PROVIDER=n8n.
2. Vérifier le compte SMTP existant. Activer NOTIFICATIONS_ENABLED dans un
   environnement de test ; toute intervention production exige l'autorisation.
3. Créer une automation manuelle de test avec validation humaine requise,
   action robia.notification.send_email, templateKey weekly_opportunities_summary
   et templateData { "organizationName": "Test ROBIA", "openOpportunityCount": 3 }.
4. Activer uniquement cette automation de test, la lancer et approuver le run.
5. Vérifier la livraison pending puis sent après le tick et la réception réelle.
6. Vérifier séparément que l'email d'audit n8n fonctionne toujours.
7. Désactiver l'automation de test. Aucun exemple métier n'est activé par défaut.

Pour tester le template audit en mode notifications dans un environnement isolé,
fournir un auditId réel appartenant à l'organisation. Une exécution manuelle
n'a pas de payload événementiel : ne pas utiliser {{event.auditId}} dans ce test
manuel ni remplacer auditId par templateData.

## Suivi et frontend

- GET /ops/notifications : liste de l'organisation.
- GET /ops/notifications/:id : détail, 404 hors organisation.
- POST /ops/notifications/:id/retry : reprise conditionnelle, 409 si inéligible.

JwtAuthGuard et OrgScopeGuard protègent les routes. Le destinataire est masqué.
Le succès d'une étape RC20 signifie mise en file (ou routage skipped), pas envoi.
Le statut de livraison doit être consulté séparément.

Le frontend liste/détail/retry reste une PR distincte. Il devra afficher les
tentatives, erreurs nettoyées, dates et distinguer routage, mise en file,
acceptation SMTP et réception. Pas d'édition des secrets depuis le dashboard.

## Validation

Tests de routage indépendants de NOTIFICATIONS_ENABLED, fallback sûr,
notifications hebdomadaires avec n8n, données audit et isolation, idempotence,
concurrence, plafond après crash, cinquième bail actif, reprise manuelle bornée,
transport et redaction. Les tests utilisent des doubles Prisma et SMTP :
aucun email réel, aucune base de production.

Avant publication : suite Jest complète, build Prisma/Nest, contrôle TypeScript,
baseline ESLint 74 erreurs / 23 avertissements sans hausse, tests Python,
tests de déploiement et validation Compose. La CI du SHA publié est la preuve
des résultats d'intégration ; les doubles ne remplacent pas un test Postgres
multi-instance ni le test de réception réel.
