# RC24 — Concurrents (Competitors)

Ajoute le suivi de sites concurrents pour les comparer au score réel de
l'organisation, sans jamais inventer de donnée et sans jamais toucher au
chemin d'audit existant (Website/Audit/Opportunity/RC-23).

## Pourquoi un modèle dédié, pas une réutilisation de `Website`/`Audit`

Un concurrent n'est PAS un site de l'organisation. Réutiliser
`AuditsService.run()`/`runSite()` tel quel aurait :
- fait passer `audit.completed` (RC-23) pour un site qui n'appartient pas à
  l'organisation, déclenchant potentiellement de vraies automations Ops
  Automation sur un événement qui ne les concerne pas ;
- pollué `web_pages`, qui est FK sur le `website_id` du site réel de
  l'organisation ;
- rendu les concurrents éligibles à la génération d'Opportunities, qui n'a
  de sens que pour le site de l'organisation.

Le nouveau modèle `Competitor` (table `competitors`) est donc totalement
séparé :

```
Competitor {
  organizationId, websiteId (le site de l'org qu'on benchmark),
  url, name?, status (pending|running|completed|failed),
  globalScore, resultJson, errorMessage, createdAt, completedAt
}
```

`CompetitorsService.run()` appelle directement `AuditRunnerService`
(`runSiteAudit()` + `runAudit()`), le même moteur réel qu'utilise
`AuditsService.run()`, mais sans passer par `AuditsService` : mêmes scores
réels, mêmes règles ("échoue si aucune page accessible"), zéro effet de
bord sur le reste du produit.

## Garanties

- **Isolation organisation** : toutes les requêtes Prisma filtrent par
  `organizationId` ; créer/lancer/supprimer un concurrent d'une autre
  organisation lève `NotFoundException`.
- **Aucun score inventé** : `globalScore`/`resultJson` viennent uniquement
  de la réponse réelle d'`AuditRunnerService.runAudit()` ; un concurrent
  reste `pending`/`failed` (jamais un score de repli) tant qu'aucun audit
  réel n'a réussi.
- **Aucune régression RC14/RC20/RC21/RC23** : aucun fichier existant
  modifié à part `prisma/schema.prisma` (ajouts additifs) et
  `app.module.ts` (une ligne d'import).
- **Aucun événement `audit.completed`** émis pour un concurrent — ce n'est
  pas un audit de l'organisation elle-même.

## Fichiers créés

- `prisma/migrations/20260915153000_add_competitors/migration.sql`
- `src/competitors/dto/create-competitor.dto.ts`
- `src/competitors/competitors.service.ts`
- `src/competitors/competitors.controller.ts`
- `src/competitors/competitors.module.ts`
- `src/competitors/competitors.service.spec.ts`
- `docs/RC24_COMPETITORS.md` — ce document.

## Endpoints

- `POST /competitors` `{ websiteId, url, name? }` — enregistre un
  concurrent (statut `pending`).
- `GET /competitors?website_id=...` — liste les concurrents d'un site.
- `POST /competitors/:id/run` — lance l'audit réel du concurrent.
- `DELETE /competitors/:id` — retire un concurrent suivi.

## Tests exécutés

```
npx jest --silent                    → 52 suites, 329 tests, tous passants
                                        (319 pré-existants + 10 nouveaux)
npx tsc --noEmit -p tsconfig.json    → aucune nouvelle erreur (1 erreur
                                        pré-existante et sans rapport dans
                                        n8n-webhook.service.spec.ts, comme
                                        documenté en RC23)
npx eslint src/competitors           → 0 nouvelle erreur en dehors du motif
                                        `any` déjà accepté dans tous les
                                        `*.service.spec.ts` du projet
                                        (17 erreurs, identique au
                                        baseline d'audits.service.spec.ts)
npm run build                        → prisma generate + nest build : succès
```

## Hors-scope (itération suivante)

- Comparaison multi-critères avancée (mots-clés, backlinks) — nécessiterait
  une vraie source de données externe, hors-scope ici par principe (pas de
  nouveau fournisseur sans scoping dédié).
- Rafraîchissement automatique / planifié des concurrents (pas de scheduler
  cron dans le projet à ce jour, cf. RC-23).
- Limite du nombre de concurrents par site (laissée ouverte pour l'instant,
  à durcir si besoin lors de la revue).
