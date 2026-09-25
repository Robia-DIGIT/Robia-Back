# Prompt à coller pour Claude — RC49 Portail candidat ODC public

RC49 — Portail candidat ODC public (backend uniquement).

Dépôt : Robia-DIGIT/Robia-Back
Branche : `rc49/claude` créée fraîche depuis `origin/main` actuel.
INTERDIT : `rc42/codex`, `rc43/*`, `develop`, `monorepo#30`, WordPress, GBP,
Meta, `seo_score_v2`, Studio.

RC43 sur ce produit = modernisation Sidebar (`robia-monorepo#67`). Ce lot
n'est pas RC43. Ne pas réutiliser le numéro 43.

Lire avant de coder :
- `docs/RC29_ODC_CANDIDATURES.md`
- `src/odc/odc.controller.ts` (tout est `JwtAuthGuard` + `OrgScopeGuard`)
- `src/odc/odc-applications.service.ts`
- `src/odc/odc-documents.service.ts` (upload RC33 — réutiliser, ne pas
  recopier)
- `src/odc/odc-programs.service.ts` (slug déjà unique par org)
- Modèle `PasswordResetToken` (`tokenHash` + `expiresAt`)
- `CLAUDE.md` (draft PR vs main, pas de merge)

## Problème

Le staff a kanban + décision + upload. Le candidat n'a aucune porte. Toute
l'API `/odc/*` exige un compte RobIA.

## Objectif

Candidat SANS compte RobIA : lien public → créer/reprendre UN dossier →
champs + pièces → submit (vrai screening) → voir SON statut → withdraw.
Staff : la même `OdcApplication` apparaît dans le kanban existant.
`decide()` reste exclusivement sur le contrôleur staff.

## Règles

- Aucune route `/odc/public` n'expose `decide`, scores, outreach,
  `listByProgram`, open/close, `programs.create`.
- Token candidat ≠ JWT staff. Un token = une candidature. Mauvais token /
  expiré / autre dossier → 404, jamais 403 révélateur.
- Programme `status !== open` → GET 404 ; POST start 409.
- `submit()` = contrôle de complétude RC29 réel. Pas de statut forcé.
- Upload = `OdcDocumentsService.upload` (MIME, 10 Mo, clé serveur).
  `storageKey` absent du DTO public.
- DTO public : jamais `organizationId`, `storageKey`, `decisionReason`,
  `proposedScores`, `finalScores`, autres candidatures.
- 1 dossier par (`programId`, email). `start()` reprend un draft existant +
  nouveau magic link, pas de doublon `in_review`.
- `@example.com` : aucun envoi SMTP (comme RC32). Autre domaine : template
  via RC26 si transport dispo. Token clair : uniquement dans l'email en
  prod ; dans la réponse JSON seulement si `NODE_ENV=test`.
- Isolation : `organizationId` résolu depuis programme/session, jamais
  depuis le body.
- Réutiliser `createApplicant`, `createApplication`, `updateAnswers`,
  `upload`, `submit`, `withdraw`. Ne pas forker le cycle de vie.
- Historique : si `submit()`/`withdraw()` exigent `userId`, accepter
  `actorUserId` nullable + `actorType` `'applicant'`. Pas de `User`
  fantôme.

## Modèle

`OdcApplicantSession` : `id`, `organizationId`, `applicationId`,
`tokenHash` `@unique`, `expiresAt`, `createdAt`, index `expiresAt`. Token :
32 bytes hex, SHA-256 en base (comme `PasswordResetToken`). TTL 14 jours.
`start()` invalide les sessions non expirées du même `applicationId` avant
d'en émettre une nouvelle.

`OdcProgram` : `publicKey` `String @unique` (cuid) — identifiant d'URL.
`slug` interne reste staff (appel-2026). Migration additive + backfill
`publicKey = cuid()` pour les lignes existantes.

Contrôleur SÉPARÉ, SANS `JwtAuthGuard` :

```
@Controller('odc/public')
GET    /odc/public/programs/:publicKey
       name, description, status, fields[], documentTypes[] — 404 si pas open
POST   /odc/public/programs/:publicKey/start
       { email, displayName } → session ; réponse prod { expiresAt, emailSent }
       test uniquement : + magicToken
GET    /odc/public/applications/:token
       status, answers, documents (sans storageKey), missing fields/docs
PATCH  /odc/public/applications/:token/answers
       seulement draft | incomplete
POST   /odc/public/applications/:token/documents/upload
       multipart, même service RC33
POST   /odc/public/applications/:token/submit
POST   /odc/public/applications/:token/withdraw
       { reason }
```

## Tests obligatoires

- `start` closed/draft → 409/404
- `start` 2× même email → 1 application, nouvelle session
- token expiré / inconnu / dossier B → 404
- `submit` incomplet → `incomplete` ; complet → `in_review` (vrai
  screening)
- aucune route publique `decide`
- upload MIME refusé → 0 fichier orphelin
- DTO public sans `storageKey` / `decisionReason` / scores /
  `organizationId`
- session org A × `publicKey` org B → 404
- FakePrisma étendu (sessions + `publicKey`)

## Sécurité (bloquant Codex — calquer `AuthService.forgotPassword`)

- `start()` : réponse unique, cooldown 60 s / email+programme, délai
  ~300 ms.
- Token clair : email seulement ; JSON seulement si `NODE_ENV=test` ET
  `ODC_PUBLIC_RETURN_TOKEN=1`.
- Comparer `tokenHash` en constante (`crypto.timingSafeEqual`).
- Invalider les sessions précédentes du même `applicationId`.
- Écriture interdite dès `in_review`/`accepted`/`rejected`/`withdrawn`/
  `waitlisted`.
- Rate limit IP sur `start` et upload.
- Tests : énumération email, cooldown, token dans DTO prod absent,
  `timingSafe`, 409 écriture post-submit.

## Docs

`docs/RC49_ODC_PUBLIC_PORTAL.md` + `docs/RC49_CLAUDE_PROMPT.md`.

## Hors périmètre

Frontend, SMTP nouveau provider, Google login, i18n, paiement, WordPress
`#66`, RC43–48 UI.

PR draft vs `main`. Aucun merge ni déploiement.
Livrer : SHA, URL PR, fichiers, nb tests, lint/build/`prisma validate`,
risques (`actorUserId` nullable).
