# RC33 — Stockage réel des pièces ODC

`POST /odc/applications/:id/documents` (RC29) accepte un `storageKey` fourni par le client : un JSON suffit à faire passer un document en `received`, sans qu'aucun octet ne soit jamais stocké. Ce lot ajoute un vrai chemin d'upload, sans casser l'ancien.

## Ce qui existe maintenant

**Deux chemins, côte à côte** :
- `POST /odc/applications/:id/documents` (JSON, inchangé) — métadonnées seules, `storageKey` optionnel fourni par l'appelant. Reste utilisé par le seed RC32 et par tout enregistrement manuel côté staff.
- `POST /odc/applications/:id/documents/upload` (multipart, nouveau) — upload réel. `storageKey` n'existe pas dans son DTO ; en envoyer un dans le body multipart le fait rejeter par le `ValidationPipe` global (`whitelist` + `forbidNonWhitelisted`).

**`OdcStorage`** (`src/odc/storage/odc-storage.ts`) — interface `put`/`get`/`exists` sur une clé opaque (jamais un chemin local). **`LocalOdcStorage`** en est la seule implémentation : fichiers sous `ODC_UPLOAD_DIR` (défaut `var/odc-uploads`), jamais commités (voir `.gitignore`). Un futur adaptateur S3 n'a besoin que de satisfaire la même interface — rien côté appelant ne change.

**Clé émise serveur** : `{organizationId}/{applicationId}/{documentId}/{uuid}.ext` — chaque segment est un id déjà connu du serveur, jamais une entrée client. `documentId` est généré avant l'écriture et réutilisé comme id de la ligne `OdcDocument` elle-même, donc les deux ne peuvent jamais diverger. L'extension est dérivée du MIME type validé, jamais du nom de fichier client.

**`OdcDocumentsService`** orchestre l'upload : valide (statut de la candidature, appartenance du type de pièce, MIME autorisé, taille ≤ 10 Mo) **avant** d'écrire le moindre octet — un rejet ne laisse jamais de fichier orphelin. Écrit ensuite via `OdcStorage.put()`, vérifie `exists()`, et seulement alors persiste la ligne `OdcDocument` via `OdcApplicationsService.addUploadedDocument()` (toujours `received` — pas de `pending_upload` possible sur ce chemin).

**`GET /odc/documents/:documentId/file`** — stream, jamais bufferisé en mémoire. Cherche d'abord en base (organisation-scopée), puis lit via `OdcStorage.get(storageKey)`. **404** (jamais 403, qui confirmerait l'existence à une autre organisation) dans tous les cas suivants : autre organisation, document `pending_upload`, `storageKey` absent, ou fichier introuvable côté stockage — y compris les clés `demo/seed/odc/...` du seed RC32, qui n'ont jamais été écrites nulle part.

## Règles respectées

- Statuts autorisés pour ajouter une pièce (upload ou JSON) : `draft | incomplete | in_review` — même règle des deux côtés (`resolveAddableDocumentType()`, partagée).
- MIME vérifié contre `OdcDocumentType.mimeAllow`.
- Taille max 10 Mo, vérifiée deux fois (limite multer + re-vérification dans le service).
- `storageKey` toujours serveur — jamais fourni par le client sur `/upload` ; sur le JSON existant, il reste un choix délibéré et documenté (métadonnées seules).
- Isolation stricte par `organizationId` partout, y compris sur le téléchargement.
- Aucune route candidat public, aucun `robia.odc.decide`, aucun appel Serper/Apify/GBP/Meta write.
- ESLint : 73 erreurs / 23 avertissements après ce lot (baseline 74/23 — pas de hausse).

## Hors périmètre (prochains lots)

- Adaptateur S3 réel — l'interface `OdcStorage` le permet déjà, aucune implémentation dans ce lot faute de credentials.
- Front (`PageOdcApplication` : input d'upload par type de pièce, bouton téléchargement, empty state pour un 404) — RC33b, séparé.
- Portail candidat public, scan antivirus, parsing CV/NLP — non demandés, non ajoutés.
