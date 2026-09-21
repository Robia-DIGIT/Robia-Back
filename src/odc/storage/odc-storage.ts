// RC-33 — the storage abstraction that keeps OdcDocumentsService independent
// of any specific backend, the same "swap the class, never the caller" shape
// as RC-26's NotificationTransport. A local filesystem implementation
// (LocalOdcStorage) is the only one in this RC; a future S3 (or other
// object-store) swap only ever needs a new class satisfying this interface
// — its key space is already backend-agnostic (an opaque string, never a
// local filesystem path), so nothing here assumes a local disk.

export interface OdcStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<NodeJS.ReadableStream | null>;
  exists(key: string): Promise<boolean>;
  // RC-33 hardening — the rollback half of upload(): a file can be written
  // successfully and then the OdcDocument row's own DB write can still
  // fail (constraint violation, connection drop, ...). Never a hard error
  // if the key is already gone (deleting twice, or deleting a key that was
  // never written, must both be safe no-ops) — the caller's own rollback
  // path must never itself throw and mask the original DB failure.
  delete(key: string): Promise<void>;
}

export const ODC_STORAGE = Symbol('ODC_STORAGE');

// 10 MiB — the hard cap this RC's spec sets for a single ODC document
// upload. Enforced twice: multer's own `limits.fileSize` (rejects an
// oversized stream before it is fully buffered) and OdcDocumentsService
// (defense in depth, the same "never trusted to a single layer" posture as
// OdcApplicationsService.decide()'s own re-checked guard).
export const MAX_ODC_UPLOAD_BYTES = 10 * 1024 * 1024;
