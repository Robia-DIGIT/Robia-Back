# RC33 hardening — stockage des documents ODC

RC-33 (upload réel des documents ODC) avait six failles réelles : (1) aucun chemin inscriptible et persistant en production ; (2) la route JSON publique acceptait un `storageKey` arbitraire, et `storageKey` fuitait dans les réponses API ; (3) un fichier écrit avec succès pouvait rester orphelin si l'écriture DB échouait ensuite ; (4) aucune politique explicite pour plusieurs documents du même type ; (5) `OdcProgramsService.update()` pouvait supprimer/recréer des critères et types de documents déjà référencés par des candidatures existantes ; (6) aucun test d'intégration ne couvrait ces scénarios.

## 1. Chemin de stockage persistant en production

`docker-compose.production.yml` — le service `backend` monte désormais un volume nommé `robia_odc_uploads` sur `/data/odc-uploads`, avec `ODC_UPLOAD_DIR=/data/odc-uploads` dans son `environment`. `read_only: true` reste inchangé : un montage de volume nommé explicite reste inscriptible indépendamment de la racine en lecture seule du conteneur.

`Dockerfile` — `RUN mkdir -p /data/odc-uploads && chown node:node /data/odc-uploads` avant `USER node`, pour que le volume nommé (vide au premier montage) hérite du contenu et des permissions du répertoire de l'image — inscriptible par l'utilisateur `node` non-root dès le premier démarrage.

`DEPLOYMENT.md` — nouvelle section « Stockage persistant des documents ODC » : permissions (aucune intervention manuelle requise), sauvegarde (`docker run ... tar czf`, ce volume n'est pas couvert par `backup-supabase.sh`), restauration.

`deploy/tests/test_production_storage.py` (nouveau) — 5 tests de validation statique (`docker compose config`, sans daemon) : `ODC_UPLOAD_DIR` présent, un volume nommé monté exactement sur `/data/odc-uploads`, le volume déclaré au niveau racine (survit à la recréation), `read_only` toujours vrai, jamais sous `/tmp`.

`deploy/tests/test_odc_storage_integration.py` (nouveau) — 2 tests d'intégration réels (scénarios 1 et 2 de la §6) : build de la vraie image `runtime`, conteneur avec le même `--read-only`/tmpfs/volume que la prod, écriture puis recréation du conteneur, le fichier survit. Ces tests nécessitent un daemon Docker réel — absents dans ce bac à sable (aucun daemon accessible), ils s'exécutent réellement dans le job `deployment-tests` de la CI GitHub Actions (`timeout-minutes` relevé de 5 à 15 pour leur laisser le temps du build).

## 2. Fin de la confiance dans `storageKey`

`CreateOdcDocumentDto` (route JSON publique `POST .../documents`) n'a plus de champ `storageKey` — rejeté par le `ValidationPipe` (`forbidNonWhitelisted`) si un client en envoie un. Cette route ne crée plus que des placeholders `pending_upload` ; seul l'upload réel (`POST .../documents/upload`, via `OdcApplicationsService.addUploadedDocument()`, jamais accessible depuis un DTO client) atteint `received`.

`storageKeyBelongsTo()` (nouveau, `odc-storage-key.ts`) — `getFile()` vérifie désormais que le `storageKey` d'un document appartient canoniquement à son propre `organizationId`/`applicationId`/`id` (préfixe exact) avant de le lire. Une ligne pré-hardening ou autrement altérée est refusée (404), jamais servie aveuglément.

`ODC_DOCUMENT_PUBLIC_SELECT` (nouveau, `odc-applications.service.ts`) — `storageKey` n'apparaît plus jamais dans une réponse d'application (`getApplication`, `listByProgram`, `addDocument`, `addUploadedDocument`) : un `select` Prisma explicite, partagé par les trois requêtes, l'exclut plutôt que d'espérer qu'aucun appelant ne le lise.

Seed de démo (RC-32) — n'utilise plus la route publique dangereuse : `odc-demo-seed.ts` appelle directement `addUploadedDocument()` (le chemin serveur uniquement) avec une clé canonique `{organizationId}/{applicationId}/{documentId}/...`, sans jamais écrire de vrai fichier — comportement inchangé pour le téléchargement (404 propre, `getFile()` ne trouve rien via `OdcStorage.get()`).

**Lignes existantes** — `storageKeyBelongsTo()` protège déjà, en temps réel, toute ligne pré-hardening : elle ne peut simplement plus jamais être téléchargée (fail-closed), sans script de migration nécessaire. `scripts/cleanup-odc-orphan-files.ts` (voir §3) liste aussi ces lignes non-canoniques pour un ré-upload manuel.

## 3. `OdcStorage.delete()` et rollback

`OdcStorage.delete(key)` (nouveau sur l'interface, implémenté dans `LocalOdcStorage` via `rm(..., {force:true})` — no-op sûr si la clé n'existe pas ou a déjà été supprimée).

`OdcDocumentsService.upload()` — si l'écriture du fichier réussit mais que `addUploadedDocument()` échoue (contrainte, connexion DB perdue), le fichier vient d'être écrit est supprimé avant de relancer l'erreur d'origine. Un échec du rollback lui-même est avalé, jamais remonté à la place de l'erreur DB réelle.

`scripts/cleanup-odc-orphan-files.ts` (nouveau, invocation manuelle uniquement, même convention que `scripts/seed-odc-demo.ts`) — dry-run par défaut (`--delete` pour agir) : liste les fichiers sous `ODC_UPLOAD_DIR` sans ligne `received` correspondante (orphelins, supprimables), et les lignes `received` dont le `storageKey` n'est pas canonique (jamais supprimées automatiquement — signalées pour ré-upload manuel).

## 4. Politique multi-documents : remplacement atomique

`OdcDocument.@@unique([applicationId, documentTypeId])` (nouvelle contrainte) — au plus un document par (candidature, type de document), à tout instant. `addUploadedDocument()` supprime l'éventuel occupant du créneau (reçu ou encore `pending_upload`) et crée la nouvelle ligne dans la **même transaction** — jamais un instant avec zéro ou deux lignes. La clé de stockage remplacée est renvoyée à l'appelant, qui supprime ce fichier devenu orphelin une fois la transaction réellement validée (jamais avant).

`addDocument()` (route metadata-only) refuse désormais de créer un placeholder si le créneau est déjà occupé (`ConflictException`) — elle ne touche jamais `OdcStorage`, donc ne peut jamais nettoyer un vrai fichier qu'un occupant `received` pointerait déjà.

Conséquence structurelle : puisqu'il n'existe jamais plus d'un document par type à un instant donné, un frontend qui sélectionne un document par type ne peut plus jamais avoir besoin de choisir entre plusieurs candidats via un `find()` sur un ordre non défini — le problème est éliminé à la source côté backend, pas contourné côté frontend. (Cette PR reste backend-only ; un audit du code frontend correspondant est recommandé en suivi, hors périmètre ici.)

**Lignes existantes** — la migration `20260921130000_odc_document_unique_slot` déduplique d'abord tout créneau existant qui contiendrait déjà plusieurs lignes (conserve la plus récente par `created_at DESC`, id en départage, supprime les autres) avant de créer la contrainte unique — une réconciliation ponctuelle, jamais répétée.

## 5. Protection de la définition du programme

`OdcProgramsService.update()` — si la requête touche `criteria` et/ou `docTypes`, et qu'au moins une `OdcApplication` existe déjà pour ce programme, la requête est refusée (`ConflictException`) avant tout `deleteMany()`. Avant ce garde-fou, la même requête aurait soit levé une erreur de contrainte FK brute et non gérée (`OdcScoreLine.criterionId`/`OdcDocument.documentTypeId` référencent ces lignes, `Restrict` étant le comportement par défaut de Prisma), soit — pour un programme sans candidature encore, donc sans contrainte à violer — silencieusement redéfini le programme sous les pieds d'une candidature créée juste après, avec des ids qui ne correspondent plus aux mêmes critères.

Politique choisie : refuser la modification (l'option la plus simple des deux proposées) plutôt qu'introduire des identifiants versionnés — aucune route de ce RC n'a besoin d'éditer rétroactivement une définition déjà en service, seulement de ne plus casser silencieusement celle qui l'est déjà. `fields` n'est référencé par aucune clé étrangère (seule sa `key` est lue depuis le JSON libre `answers`) et reste librement remplaçable.

## 6. Tests d'intégration (7 scénarios du cahier des charges)

1. Upload réel face à la configuration du conteneur de production → `deploy/tests/test_odc_storage_integration.py` (daemon Docker requis, exécuté en CI).
2. Le fichier persiste après recréation du conteneur → même fichier.
3. Tentative cross-tenant avec le `storageKey` d'une autre organisation → `odc-documents.service.spec.ts` (« ne canoniquement belong »).
4. `storageKey` absent des réponses → `odc-applications.service.spec.ts` (« never exposes storageKey »).
5. Échec Prisma après `put()` → pas de fichier orphelin → `odc-documents.service.spec.ts` (rollback tests).
6. Un second CV → un fichier courant déterministe → `odc-applications.service.spec.ts` (remplacement atomique).
7. Modifier un programme qui a déjà des documents et des scoreLines → `odc-programs.service.spec.ts` (scénario complet avec document + scoreLine réels).

## Hors périmètre

Audit du code frontend (`robia-monorepo`) pour retirer un éventuel `find()` sur un ordre non défini — rendu structurellement sans risque par la politique de remplacement atomique (§4), mais cette PR reste backend-only comme demandé ; suivi recommandé côté frontend pour simplifier le code en conséquence, pas pour corriger un bug qui subsisterait.

Un vrai stockage S3/objet — `OdcStorage` reste une interface backend-agnostique (RC-33 initial) ; seule `LocalOdcStorage` existe dans ce RC.
