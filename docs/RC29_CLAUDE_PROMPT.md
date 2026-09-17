# Prompt à coller pour Claude — RC29 ODC Back

RC29 — Domaine ODC / candidatures (pas RC28 : RC28 = visibilité retries, déjà fusionné).

Dépôt : Robia-DIGIT/Robia-Back
Branche : `rc29/claude` créée fraîche depuis `origin/main` actuel (contient RC27 / merge 202e838+).
Ne pas réutiliser `rc28/claude`.

Lis `docs/RC29_ODC_CANDIDATURES.md` en entier avant de coder. C'est la spec. Ne pas inventer d'autres statuts.

Objectif :
Workflow métier Orange Digital Center : programmes, candidats, candidatures, pièces, critères, résumé IA, scores proposés vs figés, décision humaine, historique, événements RC20, actions registry lecture/draft only.

Règles :
- Isolation `organizationId` sur chaque requête (même pattern que ActionItem / Automation).
- L'IA et les automations ne passent JAMAIS une candidature en accepted/rejected.
- `decide()` = seule voie vers accepted | rejected | waitlisted. Motif obligatoire.
- Donnée manquante = null / incomplete, jamais un total à 0.
- Pas de Serper, Apify, GBP, Meta, seo_score_v2.
- Emails = RC26 existant.
- ActionItem créé par `robia.odc.create_review_task` reste draft/not_started.
- Émettre les eventType documentés via le bus RC23 (pas audit.completed).
- Ajouter relations Organization. Pas de suppression physique des candidatures soumises.

Livrables :
- Prisma + migration
- Module Nest `src/odc/` (controller, service, dto, guards org)
- Enregistrement des 3 actions registry
- Émission des 5 events
- `docs/RC29_ODC_CANDIDATURES.md` (déjà dans le dépôt si cette PR docs est mergée — sinon l'inclure)
- Tests listés dans la spec (isolation, transitions, decide, registry)
- Étendre FakePrisma si les tests existants le nécessitent, comme RC27

PR draft. Aucun merge ni déploiement.
Fournir : SHA, lien PR, fichiers, nb tests, CI, risques.

Ne commence pas le frontend monorepo dans cette branche.
