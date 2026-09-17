# RC29 — Domaine ODC / candidatures

**Numérotation.** Le numéro RC28 est déjà consommé : visibilité frontend des reprises d'étape ([robia-monorepo#49](https://github.com/Robia-DIGIT/robia-monorepo/pull/49), fusionné). Le domaine Orange Digital Center **n'est pas RC28**. Ce lot est **RC29**.

Branche : `rc29/claude` depuis `origin/main` (SHA de référence au démarrage : `202e838` côté Back, contenant RC27).

Socle : RC14 (ActionItem + validation humaine), RC20 (automations, registry, events), RC25 (rappels planifiés), RC26 (email, jamais d'adresse en clair).

## Ce que c'est

Assistant administratif pour un **programme ODC** (appel à candidatures, incubation, formation, OSC interne) :

- programmes et cohortes
- candidatures et pièces
- critères et score **proposé**
- résumé IA
- tâches et rappels
- **décision finale toujours humaine**
- historique immuable

Ce n'est pas le Local Copilot. Ce n'est pas Orange Money. Scope automation déjà réservé dans RC20 : `PROGRAM` / `COHORT` (non implémentés avant RC29). RC29 les active **sans** les mélanger à `ORGANIZATION` (PME).

## Règles non négociables

1. L'IA **ne décide jamais** acceptation, liste d'attente ou rejet.
2. Toute action d'automation ODC qui touche une candidature crée un `ActionItem` `draft` ou un événement. Jamais `approvalStatus=approved` automatique.
3. Isolation : chaque ligne porte `organizationId`. Une org PME ne voit pas les candidatures ODC d'une autre org.
4. Donnée manquante = `null` / statut `incomplete`. Jamais un score 0 inventé.
5. Emails via RC26 uniquement (destinataire = user interne résolu côté serveur).
6. Pas de Serper, Apify, GBP, Meta, SEO V2 dans ce lot.
7. Pas de fichier binaire dans Git. Pièces = métadonnées + `storageKey` (local/S3 plus tard). Upload réel peut être un stub `pending_upload` en v1.

## Acteurs

| Rôle produit | Qui | Droits |
|--------------|-----|--------|
| `odc.admin` | Owner de l'org ODC (staff RobIA / ODC) | Tout sauf contourner l'historique |
| `odc.reviewer` | Membre de l'org, pas owner | Lire, scorer, commenter, **proposer** ; pas décider seul si le programme `requireDualReview=true` |
| `odc.applicant` | Candidat | Créer/éditer **sa** candidature tant que `draft` ou `incomplete` ; lire le statut public ; jamais la file interne |
| Système | Automations RC20 | Résumés, flags, tâches draft, emails |

v1 : pas de compte candidat public. Le candidat est une **fiche** (`OdcApplicant`) saisie par le staff ou un formulaire interne. Un `userId` optionnel si plus tard un portail existe.

**Note d'implémentation RC29** : le guard org actuel (`OrgScopeGuard`, réutilisé tel quel — même pattern qu'ActionItem/Automation) résout l'organisation par propriété (`ownerId`), sans notion de rôle `odc.admin`/`odc.reviewer`. Le RBAC fin décrit ci-dessus n'est **pas** construit dans RC29 (aucun modèle Rôle/Membership dans la liste Prisma cible) — toute personne authentifiée de l'organisation a les mêmes droits sur les routes `/odc/*`, comme c'est déjà le cas pour `/actions` et `/ops/automations`. Documenté ici comme risque résiduel, pas comme un oubli.

## Cycle de vie — Programme

`draft` → `open` → `closed` → `archived`

- `open` : accepte des candidatures (fenêtre `opensAt` / `closesAt`).
- `closed` : plus de nouvelle soumission ; revue possible.
- Suppression : interdite si une candidature `submitted+` existe. Archiver.

**Note d'implémentation** : aucune route `POST /odc/programs/:id/archive` n'existe dans cette RC (absente de la table API ci-dessous) — `archived` est un statut valide du modèle mais aucun chemin applicatif ne l'atteint encore. `OdcProgramsService.update()` refuse toute édition d'un programme déjà `archived`, testé en simulant directement l'état en base.

## Cycle de vie — Candidature

```
draft
  → submitted          (candidat ou staff « déposer »)
  → screening          (auto : pièces + champs requis)
       ├→ incomplete   (pièce/champ manquant — humain ou candidat complète)
       └→ in_review
            → waitlisted
            → accepted     ← HUMAIN uniquement
            → rejected     ← HUMAIN uniquement
            → withdrawn    (candidat / staff, motif obligatoire)
```

Transitions **interdites** au moteur / à l'agent :

- `* → accepted`
- `* → rejected`
- `waitlisted → accepted` sans `decide()`

`screening` peut être automatique. `incomplete → in_review` quand le check de complétude repasse.

**Note d'implémentation** : `submit()` traverse réellement `submitted` → `screening` → (`incomplete` | `in_review`) comme trois écritures séquentielles (une par transition), chacune journalisée dans `OdcHistoryEvent` — jamais un seul saut direct `draft → incomplete/in_review` qui masquerait la transition intermédiaire. `withdraw()` est autorisé depuis n'importe quel statut **non terminal** (pas depuis `accepted`/`rejected`/`withdrawn` déjà décidé) — le `*` de la spec est interprété comme « tout statut où une décision n'a pas encore été figée », jamais comme un moyen de défaire une décision humaine déjà prise.

## Complétude (déterministe, pas l'IA)

Une candidature est complète ssi :

- tous les `OdcField` `required=true` du programme ont une valeur non vide
- toutes les `OdcDocumentType` `required=true` ont au moins une pièce `received`

Sinon : `incomplete` + liste `missing[]` (préfixée `field:<key>` / `document:<key>` — voir `odc-completeness.ts`). Pas de score.

## Score

- Chaque `OdcCriterion` : `weight` (int > 0), `maxPoints`.
- `OdcScoreLine` : `proposedPoints` (IA ou reviewer) + `finalPoints` (humain).
- `proposedTotal` = somme pondérée des `proposedPoints` **seulement si** toutes les lignes required ont un `proposedPoints` **non null**.
- `finalTotal` idem sur `finalPoints`.
- Affichage : si incomplet → `finalTotal = null`, jamais 0.

L'IA remplit `proposedPoints` + `rationale`. Un reviewer copie ou corrige vers `finalPoints`. La décision `accepted` n'est **pas** un seuil auto, même si `finalTotal >= threshold`.

**Note d'implémentation** : la somme pondérée porte sur *tous* les critères présents dans une ligne de score (un critère optionnel noté contribue à la somme) ; le blocage « jamais 0 par défaut » ne s'applique qu'aux critères `required` : dès qu'un seul required manque, le total entier est `null`, quel que soit l'état des critères optionnels.

## Entités Prisma

Voir `prisma/schema.prisma` (modèles `OdcProgram`, `OdcField`, `OdcCriterion`, `OdcDocumentType`, `OdcApplicant`, `OdcApplication`, `OdcDocument`, `OdcScoreLine`, `OdcHistoryEvent`) — fidèle à la cible ci-dessous, avec une seule relation `User` ajoutée (`OdcApplication.decidedBy`, pour « décisions », comme demandé) ; `createdById` (programme) et `actorUserId` (historique) restent des identifiants bruts, sans relation, comme dans la cible d'origine.

`OdcHistoryEvent` : append-only. Pas d'update/delete API.

## API (toutes préfixées `/odc`, guard org)

| Méthode | Route | Effet |
|---------|-------|--------|
| POST | `/odc/programs` | crée `draft` |
| PATCH | `/odc/programs/:id` | métadonnées, champs, critères, docTypes (remplacement complet des listes fournies) — interdit si `archived` |
| POST | `/odc/programs/:id/open` | `draft→open` |
| POST | `/odc/programs/:id/close` | `open→closed` |
| GET | `/odc/programs` | liste org |
| POST | `/odc/applicants` | fiche candidat |
| POST | `/odc/programs/:id/applications` | `draft` — programme doit être `open` |
| PATCH | `/odc/applications/:id` | answers (fusionnées, jamais remplacées) — tant que draft/incomplete |
| POST | `/odc/applications/:id/documents` | métadonnée pièce — draft/incomplete/in_review |
| POST | `/odc/applications/:id/submit` | → submitted puis screening auto |
| POST | `/odc/applications/:id/propose-summary` | IA/reviewer → `summaryDraft` seulement |
| POST | `/odc/applications/:id/propose-scores` | IA/reviewer → `proposedPoints` |
| PATCH | `/odc/applications/:id/scores` | `finalPoints` humains |
| POST | `/odc/applications/:id/decide` | accepted/rejected/waitlisted + motif obligatoire |
| POST | `/odc/applications/:id/withdraw` | withdrawn + motif |
| GET | `/odc/applications/:id` | dossier + missing + historique |
| GET | `/odc/applications/:id/history` | events |

`decide` refuse si :

- statut ∉ `{in_review, waitlisted}`
- `decisionReason` vide

**Note d'implémentation** : `requireDualReview` est persisté et exposé sur le programme mais **n'est pas appliqué** par `decide()` dans cette RC — le schéma ne porte aucun champ traçant « qui a figé quelle ligne de score », condition nécessaire pour vérifier qu'un second reviewer distinct du décideur est intervenu. Documenté comme risque résiduel plutôt que d'inventer un champ hors spec.

Aucune route `execute` / `apply` de décision.

## Événements RC20 (`eventType`)

Unicité déjà : `(organizationId, eventType, eventKey)`.

| eventType | eventKey | Quand |
|-----------|----------|--------|
| `odc.application.submitted` | `applicationId` | submit OK |
| `odc.application.incomplete` | `applicationId` | screening KO |
| `odc.application.ready_for_review` | `applicationId` | screening OK → in_review |
| `odc.document.received` | `documentId` | pièce received |
| `odc.application.decided` | `applicationId` | après decide() humain |

Émis via le même mécanisme d'événement in-process que `audit.completed` (RC23, `@nestjs/event-emitter`) : `OdcApplicationsService` émet un événement plain (`odc-events.ts`), et `OdcEventListener` (dans `ops-automation`, comme `AuditCompletedEventListener`) le traduit en `AutomationEvent` via `AutomationsService.emitEvent()`. `OdcModule` n'importe jamais `OpsAutomationModule` — seule `OpsAutomationModule` importe `OdcModule` (pour ses 3 actions), ce qui évite toute dépendance circulaire. `withdrawn` n'émet aucun événement RC20 (absent de cette liste) : uniquement un `OdcHistoryEvent`.

## Actions registry (nouvelles, lecture / draft only)

| actionType | Fait | Interdit |
|------------|------|----------|
| `robia.odc.prepare_application_summary` | Écrit `summaryDraft` (résumé déterministe, calculé depuis les données déjà persistées — aucun appel LLM dans ce lot) | changer le statut |
| `robia.odc.flag_missing_documents` | Recalcule `missing` via la même fonction déterministe que `submit()`, passe `incomplete→in_review` si complet | agir sur tout autre statut ; inventer des pièces |
| `robia.odc.create_review_task` | `ActionItem` title imposé (calculé serveur), `draft`/`not_started` | approuver la tâche ; titre fourni par l'appelant |

Pas d'action `robia.odc.decide` — testé explicitement (absence au registre).

## Rappels (RC25)

Automation `scheduled` : « candidatures `in_review` depuis N jours » → `create_review_task` + email staff. `requiresApproval=true` par défaut. **Non livré dans cette RC** : aucune automation n'est créée automatiquement — un administrateur la configure via l'API `/ops/automations` existante, en utilisant les actions ci-dessus (scope `PROGRAM` désormais disponible, voir ci-dessous).

## Activation des scopes `PROGRAM` / `COHORT` (RC20 → RC29)

`Automation.scope` existait déjà (colonne texte, défaut `'ORGANIZATION'`) mais n'était ni exposé par l'API ni validé. RC29 l'active : `CreateAutomationDto`/`UpdateAutomationDto` acceptent désormais `scope` parmi `ORGANIZATION | ROBIA_INTERNAL | PROGRAM | COHORT` (`AUTOMATION_SCOPES`), toujours optionnel — un appel qui ne le fournit pas obtient encore `'ORGANIZATION'` via le défaut Postgres, comportement strictement inchangé. Rien dans `AutomationsService` ne filtre par `scope` : `organizationId` reste la seule frontière d'isolation réellement appliquée ; `scope` n'est qu'une catégorisation.

## Tests

- `odc-completeness.spec.ts` (13) — complétude et somme pondérée, purs.
- `odc-programs.service.spec.ts` (8) — cycle de vie programme, isolation, unicité de slug, remplacement des listes de définition, garde `archived`.
- `odc-applications.service.spec.ts` (26) — isolation, création, réponses fusionnées, pièces, `submit()`/screening, `recomputeMissingDocuments()`, scores proposés/finaux, `decide()`, `withdraw()`, helpers du registre.
- `ops-actions-registry.service.spec.ts` (+4) — délégation des 3 nouvelles actions, absence de `robia.odc.decide`.
- `odc-event.listener.spec.ts` (6) + `odc-event.wiring.spec.ts` (1) — traduction des 5 événements ODC vers `AutomationsService.emitEvent()`, isolation des échecs, câblage réel `EventEmitter2`.
- `automations.service.spec.ts` (+2) — activation des scopes `PROGRAM`/`COHORT`.

58 tests nouveaux pour RC29, 573 au total sur l'ensemble du dépôt.

## Hors périmètre RC29

- Portail public candidat / magic link.
- Stockage S3 réel (stub `pending_upload` en v1).
- Notation automatique qui accepte.
- Multi-programmes Orange Formation hors ODC.
- Front (lot séparé, RC29b, si le Back est mergé).
- IoT, GBP, Meta, SEO.
- RBAC fin (`odc.admin`/`odc.reviewer`/`odc.applicant`) — voir « Acteurs » ci-dessus.
- Application de `requireDualReview` par `decide()` — voir « API » ci-dessus.
