import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  OdcApplicationsService,
  type OdcApplicationWithRelations,
} from './odc-applications.service';
import {
  MAX_ODC_UPLOAD_BYTES,
  ODC_STORAGE,
  type OdcStorage,
} from './storage/odc-storage';
import { buildOdcStorageKey } from './storage/odc-storage-key';

// A minimal, framework-agnostic shape — never Express.Multer.File directly,
// so this service (and its tests) never depend on multer or an HTTP layer.
// An Express.Multer.File already satisfies this structurally.
export interface OdcUploadFileInput {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export interface OdcDocumentFile {
  document: {
    originalName: string;
    mimeType: string;
  };
  stream: NodeJS.ReadableStream;
}

/**
 * RC-33 — orchestrates a real upload: validate against the application's own
 * rules (status, docType membership, MIME allowlist, size), write the bytes
 * to OdcStorage under a server-generated key, confirm they actually landed,
 * only then persist the OdcDocument row (always 'received' — see
 * OdcApplicationsService.addUploadedDocument()). Never accepts a
 * caller-supplied storageKey; the multipart body only ever carries
 * `documentTypeId` (see UploadOdcDocumentDto — anything else is rejected by
 * the global ValidationPipe's whitelist).
 */
@Injectable()
export class OdcDocumentsService {
  constructor(
    private readonly applications: OdcApplicationsService,
    @Inject(ODC_STORAGE) private readonly storage: OdcStorage,
  ) {}

  async upload(
    organizationId: string,
    applicationId: string,
    documentTypeId: string,
    file: OdcUploadFileInput,
  ): Promise<OdcApplicationWithRelations> {
    if (file.size > MAX_ODC_UPLOAD_BYTES) {
      throw new PayloadTooLargeException(
        `File exceeds the ${MAX_ODC_UPLOAD_BYTES} byte limit.`,
      );
    }

    // The same status + docType-membership checks addDocument() enforces,
    // run here *before* writing a single byte — a rejected upload (wrong
    // status, unknown docType) must never leave an orphan file on disk.
    // addUploadedDocument() re-checks the same two on the way in; this
    // isn't redundant, it's what makes the ordering (validate, then write,
    // then persist) actually hold.
    const docType = await this.applications.assertDocumentAddable(
      organizationId,
      applicationId,
      documentTypeId,
    );
    if (!docType.mimeAllow.includes(file.mimetype)) {
      throw new BadRequestException(
        `MIME type "${file.mimetype}" is not allowed for document type "${docType.key}".`,
      );
    }

    const documentId = randomUUID();
    const storageKey = buildOdcStorageKey(
      organizationId,
      applicationId,
      documentId,
      file.mimetype,
    );
    await this.storage.put(storageKey, file.buffer);
    if (!(await this.storage.exists(storageKey))) {
      throw new InternalServerErrorException(
        "Le fichier n'a pas pu être confirmé après écriture.",
      );
    }

    return this.applications.addUploadedDocument(
      organizationId,
      applicationId,
      {
        id: documentId,
        documentTypeId: docType.id,
        originalName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storageKey,
      },
    );
  }

  // Never 403 on a foreign document — always 404, so a caller can never
  // learn a document with that id exists in another organization. Also 404
  // (not e.g. 409/425) for 'pending_upload', a missing storageKey, or a key
  // OdcStorage can't actually read (RC-32's demo seed's own demo/seed/...
  // keys, never written to any real backend, resolve here on purpose).
  async getFile(
    organizationId: string,
    documentId: string,
  ): Promise<OdcDocumentFile> {
    const document = await this.applications.findDocument(
      organizationId,
      documentId,
    );
    if (!document || document.status !== 'received' || !document.storageKey) {
      throw new NotFoundException('Document non trouvé.');
    }
    const stream = await this.storage.get(document.storageKey);
    if (!stream) {
      throw new NotFoundException('Document non trouvé.');
    }
    return {
      document: {
        originalName: document.originalName,
        mimeType: document.mimeType,
      },
      stream,
    };
  }
}
