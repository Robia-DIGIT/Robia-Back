# RC32 — Seed démo ODC

Sans candidatures déjà en `in_review`, l'écran de tri/sélection/envoi (RC31/31b) et le kanban (RC29b) sont vides — rien à trier, rien à envoyer. Ce lot ajoute un seed explicite, jamais exécuté automatiquement, qui crée un programme démo complet et des candidatures prêtes à être triées.

## Ce que ça crée

Pour une organisation donnée :
- **1 programme** (`slug: demo-odc-2026`, statut `open`) avec 2 champs (motivation requis, LinkedIn optionnel), 2 critères de score, 2 types de pièces requis (`cv`, `pitch_deck`).
- **3 candidatures**, chacune :
  - un candidat avec un email réel (format valide) sous `@example.com` — domaine réservé IANA (RFC 2606), ne peut jamais recevoir de mail réel. Volontaire : `OdcOutreachService.send()` résout toujours le destinataire depuis `OdcApplicant.email` côté serveur, donc un envoi déclenché par erreur sur ces données de démo ne peut jamais atteindre une vraie boîte mail.
  - les réponses aux champs requis déjà remplies.
  - 2 pièces (`cv`, `pitch_deck`) avec métadonnées réalistes (nom, type MIME, taille) et un `storageKey` factice (`demo/seed/odc/...`) — pas de fichier réel, conforme au stub actuel (pas de backend de stockage branché avant le prochain lot).
  - passées par `submit()` réel (pas un statut forcé) : `draft → submitted → screening → in_review`, via le contrôle de complétude déterministe existant.

Aucune candidature n'est jamais en `accepted` / `rejected` / `waitlisted` — le seed ne fait jamais cela, seul `decide()` humain le peut, et n'est jamais appelé ici.

## Comment l'exécuter

Jamais automatique (pas dans `prisma db seed`, pas au bootstrap de l'app) :

```bash
npm run seed:odc-demo -- <organizationId> <userId>
```

Pas idempotent : un deuxième appel pour la même organisation échoue (slug déjà pris), comme n'importe quel autre appel à `OdcProgramsService.create()` avec un slug existant.

## Tests

`src/odc/examples/odc-demo-seed.spec.ts` (contre `FakeOdcPrisma`, même harnais que les autres tests ODC) : programme `open`, 3 candidatures en `in_review`, email + 2 pièces `received` par candidature, aucun domaine d'email autre que `example.com`, aucun statut décisif jamais atteint, deuxième appel rejeté, isolation par organisation.

## Hors périmètre (prochains lots)

- Upload réel (`storageKey` S3/local) — le stub `pending_upload`/métadonnées-only reste tel quel pour l'instant.
- Portail candidat public — seulement après l'upload réel.
