# RC49 — Portail candidat ODC public (backend uniquement)

Avant RC49, toute l'API `/odc/*` (RC29/RC31/RC33) exigeait un compte RobIA
(`JwtAuthGuard` + `OrgScopeGuard`). Le staff avait un kanban, une décision, un
upload. Le candidat n'avait aucune porte : il fallait que le staff saisisse
sa fiche (`OdcApplicant`) et sa candidature à sa place. Ce lot ajoute un
chemin public, sans compte, pour qu'un candidat crée/reprenne son propre
dossier, le complète, le soumette et suive son statut — sans jamais toucher
au cycle de vie existant ni à `decide()`.

RC43 sur ce produit est la modernisation Sidebar
([robia-monorepo#67](https://github.com/Robia-DIGIT/robia-monorepo/pull/67)).
Ce lot n'est pas RC43 — le numéro RC49 n'a jamais été utilisé.

## Ce qui existe maintenant

**Un contrôleur séparé, sans guard** — `OdcPublicController`
(`@Controller('odc/public')`, aucun `JwtAuthGuard`/`OrgScopeGuard`).
L'authentification est un token magic-link par candidature, jamais un JWT.
Aucune route de ce contrôleur ne peut atteindre `decide()`, les scores,
l'outreach, `listByProgram()` ou la création/ouverture/fermeture de
programme — `OdcPublicService` n'a tout simplement aucune méthode qui les
appelle (vérifié explicitement par un test de réflexion sur les deux
prototypes).

| Méthode | Route | Effet |
|---|---|---|
| GET | `/odc/public/programs/:publicKey` | `{name, description, status, fields[], documentTypes[]}` — 404 si `publicKey` inconnu ou programme non `open` |
| POST | `/odc/public/programs/:publicKey/start` | Crée ou reprend UNE candidature (voir plus bas) → `{expiresAt, emailSent}` |
| GET | `/odc/public/applications/:token` | Statut, réponses, pièces (sans `storageKey`), champs/pièces manquants |
| PATCH | `/odc/public/applications/:token/answers` | Réponses fusionnées — seulement `draft`/`incomplete` |
| POST | `/odc/public/applications/:token/documents/upload` | Multipart, même `OdcDocumentsService.upload()` que le staff |
| POST | `/odc/public/applications/:token/submit` | Écran de complétude réel (RC29), aucun statut forcé |
| POST | `/odc/public/applications/:token/withdraw` | `{reason}` — autorisé même depuis `in_review`/`waitlisted` |

**`publicKey`** (`OdcProgram.publicKey`, `@unique @default(cuid())`) est
l'identifiant d'URL public — jamais le `slug` interne, qui reste
staff-only et n'apparaît sur aucune route non authentifiée. Migration
additive : les programmes existants reçoivent un `publicKey` aléatoire
backfillé (`gen_random_uuid()`), les nouveaux l'obtiennent via le défaut
Prisma comme n'importe quel `id`.

**`OdcApplicantSession`** — une ligne = un token émis. `tokenHash`
(`sha256` hex, jamais le token en clair — même principe que
`PasswordResetToken`), `expiresAt` (TTL 14 jours), `@@index([expiresAt])`.
`start()` invalide (supprime) toutes les sessions non expirées de la même
`applicationId` avant d'en émettre une nouvelle : au plus un token
utilisable à la fois par candidature.

**Un seul dossier par (programme, email)** — `start()` retrouve ou crée
l'`OdcApplicant` par `(organizationId, email)` puis l'`OdcApplication` par
`(programId, applicantId)` (contrainte déjà existante depuis RC29) : deux
appels successifs avec le même email ne créent jamais une deuxième
candidature, seulement une nouvelle session si l'ancienne n'est plus dans
la fenêtre de cooldown.

**Réutilisation stricte du cycle de vie** — `createApplicant()`,
`createApplication()`, `updateAnswers()`, `OdcDocumentsService.upload()`,
`submit()`, `withdraw()` sont les mêmes méthodes que celles du contrôleur
staff, jamais forkées. `submit()`/`withdraw()` acceptent désormais
`userId: string | null` : un id réel signifie toujours l'acteur staff
(JWT), `null` signifie toujours le portail public — voir `resolveActor()`
dans `OdcApplicationsService`. `OdcHistoryEvent` gagne `actorType`
(`'staff' | 'system' | 'applicant'`, défaut `'staff'`, backfillé en
`'system'` pour les lignes historiques sans `actorUserId`) pour que
l'historique distingue enfin un acteur système (screening automatique) d'un
acteur humain, sans jamais inventer un `User` fantôme pour le candidat.

**Verrou d'écriture plus strict que le staff** — `updateAnswers()` et
l'upload restent ouverts à `in_review` côté staff (inchangé), mais
`OdcPublicService` refuse ces deux écritures dès que le statut n'est plus
`draft`/`incomplete` (409), *avant* même d'appeler le service interne.
`submit()` n'a besoin d'aucune garde supplémentaire : son propre contrôle
(`status !== 'draft'`) est déjà strictement plus restrictif. `withdraw()`
n'est pas concerné par cette restriction — un candidat peut retirer son
dossier même `in_review`/`waitlisted`, exactement comme le staff.

**DTO public strictement allowlisté** — `PublicOdcApplicationView` /
`PublicOdcProgramView` sont des projections explicites, jamais la ligne
Prisma brute : ni `organizationId`, ni `storageKey` (déjà exclu par le
`select` existant), ni `decisionReason`/`decidedAt`/`decidedById`, ni
`proposedTotal`/`finalTotal`/`scoreLines`, ni les critères de notation du
programme (`criteria`, `requireDualReview`, `decisionThreshold`). Les
champs manquants (`missing[]`) sont recalculés en direct via
`checkCompleteness()` (RC29, pur) plutôt que de faire confiance à la valeur
persistée, potentiellement obsolète tant que le dossier est encore `draft`.

## Sécurité (calqué sur `AuthService.forgotPassword()`)

- **Réponse unique** — `start()` renvoie toujours `{expiresAt, emailSent}`,
  qu'un dossier existe déjà pour cet email ou non, qu'un email ait
  effectivement été envoyé ou non. Un délai plancher de ~300 ms absorbe la
  variance de temps de traitement entre les deux cas.
- **Cooldown 60 s** — par candidature (donc par email+programme), vérifié
  *avant* toute invalidation de session, sur la dernière session créée
  (expirée ou non) plutôt que sur un compteur séparé.
- **Token en clair jamais renvoyé en production** — `magicToken` n'apparaît
  dans la réponse JSON que si `NODE_ENV==='test'` **et**
  `ODC_PUBLIC_RETURN_TOKEN==='1'` (les deux, pas l'un ou l'autre) ; sinon le
  token ne quitte jamais le serveur autrement que par email.
- **Comparaison à temps constant** — `resolveSession()` retrouve la session
  par le hash (index unique), puis revérifie ce hash avec
  `crypto.timingSafeEqual()` avant de faire confiance à la ligne — défense
  en profondeur au-dessus du index-lookup exact déjà utilisé par
  `PasswordResetToken`.
- **@example.com jamais envoyé** — même convention que le seed RC32 (domaine
  IANA réservé, RFC 2606) : `start()` ne contacte jamais le transport SMTP
  pour ce domaine, quel que soit son état de configuration.
- **Transport RC26 optionnel** — si `NotificationTransport.ensureReady()`
  lève (SMTP non configuré), l'email est simplement sauté (`emailSent:
  false`, logué), jamais une erreur remontée au candidat.
- **404 partout, jamais 403** — token inconnu, expiré, ou dont la session
  pointe vers une autre organisation : tous indiscernables de « cette
  ressource n'existe pas ». Aucune route publique ne peut jamais confirmer
  qu'un email ou une candidature existe pour un tiers.
- **Programme fermé** — `GET /programs/:publicKey` renvoie 404 (même
  traitement qu'un `publicKey` inconnu) ; `POST .../start` renvoie 409 (un
  programme existant mais fermé n'est pas « introuvable »).
- **Rate limit IP** — `start` et l'upload portent
  `@Throttle({ default: { limit: 5, ttl: 60_000 } })`, la même limite que
  les routes sensibles d'`AuthController`.

## Tests

`odc-public.service.spec.ts` (21 tests) — statut de programme (404/409),
reprise d'un dossier existant hors cooldown, une seule candidature par
(programme, email), cooldown 60 s + réponse unique, absence du token hors
opt-in explicite, saut SMTP sur `@example.com` et sur transport
indisponible, résolution de token (inconnu, altéré de même longueur,
expiré, isolation inter-organisation), DTO public sans champ interdit,
`submit()` réel (`incomplete` vs `in_review`), verrou d'écriture post-`in_review`
sur les réponses et l'upload (mais pas sur `withdraw()`), upload MIME
refusé sans fichier orphelin, absence structurelle de toute route
`decide`/scores/outreach/administration de programme.

`notification-templates.spec.ts` — le nouveau gabarit
`odc_applicant_magic_link` (5 gabarits au total désormais).

`fake-odc-prisma.ts` étendu : `programs.create()` génère un `publicKey`
comme un `id`, `odcProgram.findFirst()` accepte `publicKey` en clause
`where`, et un nouveau modèle `odcApplicantSession` (`create`, `findFirst`,
`deleteMany`) couvre exactement l'usage de `OdcPublicService`.

848 tests au total sur l'ensemble du dépôt après ce lot (826 avant, +22),
ESLint 74 erreurs / 23 avertissements (baseline inchangée), `tsc --noEmit` :
les mêmes 6 erreurs pré-existantes, sans rapport avec ce lot.

## Risques résiduels

- **Race sur la création d'un nouvel `OdcApplicant`** : `start()` retrouve
  l'applicant par `(organizationId, email)` puis le crée s'il est absent,
  sans contrainte unique DB sur ce couple (le modèle `OdcApplicant`
  pré-existant n'en porte pas, et l'ajouter rétroactivement risquerait de
  casser des fiches saisies manuellement par le staff avec des emails
  dupliqués). Deux appels `start()` strictement concurrents avec un email
  encore jamais vu pourraient donc, dans une fenêtre de course étroite,
  créer deux `OdcApplicant` distincts — et donc deux candidatures — pour le
  même email et le même programme. Le cas séquentiel (deux appels l'un
  après l'autre, y compris à quelques millisecondes d'écart réel) est
  correctement dédupliqué et testé ; seule la vraie concurrence
  (deux requêtes qui s'exécutent en parallèle sur le tout premier appel
  pour un email) reste ouverte.
- **Nettoyage des sessions expirées** : aucune tâche planifiée ne purge les
  lignes `OdcApplicantSession` déjà expirées (elles restent inertes —
  `resolveSession()` les rejette toujours en 404 — mais s'accumulent en
  base). Un job de purge (sur le modèle des jobs de rétention RC40) est
  hors périmètre de ce lot.
- **URL du lien magique** : `ODC_PUBLIC_PORTAL_URL` n'est pas encore
  documentée dans `.env.example`/`.env.production.example` (aucune route
  frontend n'existe encore pour la consommer — voir « Hors périmètre »).
  À défaut, l'URL retombe sur `APP_URL`/`FRONTEND_URL` + `/odc/candidature`,
  puis sur `https://app.robiacopilot.site/odc/candidature`.

## Hors périmètre (prochains lots)

- Frontend (page candidat, formulaire, suivi de statut) — RC49b si ce
  backend est mergé.
- Nouveau provider SMTP, connexion Google, i18n, paiement.
- Connecteur WordPress (#66), modernisation UI RC43–48 — jamais touchés
  par ce lot.
- Purge planifiée des sessions expirées.
- Fermer la fenêtre de course sur la création d'un tout premier
  `OdcApplicant` pour un email donné (nécessiterait une contrainte unique
  `(organizationId, email)` sur un modèle pré-existant, hors périmètre
  d'une correction additive).
