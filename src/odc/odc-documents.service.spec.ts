import { Readable } from 'node:stream';
import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { OdcApplicationsService } from './odc-applications.service';
import { OdcDocumentsService } from './odc-documents.service';
import { PrismaService } from '../prisma/prisma.service';
import { FakeOdcPrisma, type FakeRecord } from './test-support/fake-odc-prisma';
import { MAX_ODC_UPLOAD_BYTES, type OdcStorage } from './storage/odc-storage';

function baseEvents() {
  return { emit: jest.fn() };
}

// A small in-memory OdcStorage — same "no live backend, real
// read-your-writes semantics" rationale as FakeOdcPrisma.
class FakeOdcStorage implements OdcStorage {
  private readonly files = new Map<string, Buffer>();

  put(key: string, data: Buffer): Promise<void> {
    this.files.set(key, data);
    return Promise.resolve();
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.files.has(key));
  }

  get(key: string): Promise<NodeJS.ReadableStream | null> {
    const data = this.files.get(key);
    return Promise.resolve(data ? Readable.from(data) : null);
  }

  delete(key: string): Promise<void> {
    this.files.delete(key);
    return Promise.resolve();
  }

  fileCount(): number {
    return this.files.size;
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('OdcDocumentsService', () => {
  const orgA = 'org-a';
  const orgB = 'org-b';
  const userA = 'user-a';

  let prisma: FakeOdcPrisma;
  let applications: OdcApplicationsService;
  let storage: FakeOdcStorage;
  let service: OdcDocumentsService;

  beforeEach(() => {
    prisma = new FakeOdcPrisma();
    applications = new OdcApplicationsService(
      prisma as unknown as PrismaService,
      baseEvents() as never,
    );
    storage = new FakeOdcStorage();
    service = new OdcDocumentsService(applications, storage);
  });

  function createProgram(
    organizationId: string,
    overrides: Partial<{ status: string; docTypes: FakeRecord[] }> = {},
  ) {
    return prisma.odcProgram.create({
      data: {
        organizationId,
        slug: 'programme-1',
        name: 'Programme 1',
        createdById: userA,
        status: overrides.status ?? 'open',
        fields: { create: [] },
        criteria: { create: [] },
        docTypes: {
          create: overrides.docTypes ?? [
            {
              key: 'cv',
              label: 'CV',
              required: true,
              mimeAllow: ['application/pdf'],
            },
          ],
        },
      },
      include: { fields: true, criteria: true, docTypes: true },
    }) as FakeRecord & { id: string; docTypes: FakeRecord[] };
  }

  async function createDraftApplication(
    organizationId: string,
    programId: string,
  ) {
    const applicant = prisma.odcApplicant.create({
      data: { organizationId, displayName: 'Jane Doe' },
    }) as FakeRecord & { id: string };
    return applications.createApplication(organizationId, programId, {
      applicantId: applicant.id,
    });
  }

  function pdfFile(
    overrides: Partial<{ mimetype: string; size: number }> = {},
  ) {
    return {
      buffer: Buffer.from('%PDF-1.4 fake content'),
      mimetype: overrides.mimetype ?? 'application/pdf',
      originalname: 'cv.pdf',
      size: overrides.size ?? 22,
    };
  }

  // ---------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------

  it('uploads a file, creates a received document, and the same bytes come back through getFile()', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;

    const result = await service.upload(
      orgA,
      application.id,
      docTypeId,
      pdfFile(),
    );

    const document = result.documents[0];
    expect(document.status).toBe('received');
    expect(storage.fileCount()).toBe(1);

    const file = await service.getFile(orgA, document.id);
    expect(file.document.mimeType).toBe('application/pdf');
    expect((await readAll(file.stream)).toString()).toBe(
      '%PDF-1.4 fake content',
    );
  });

  it('embeds organizationId/applicationId/documentId in the storage key, never client input', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;

    const result = await service.upload(
      orgA,
      application.id,
      docTypeId,
      pdfFile(),
    );
    const document = result.documents[0];
    // storageKey is never exposed on the application response itself (see
    // ODC_DOCUMENT_PUBLIC_SELECT) — findDocument() is the one internal,
    // narrower query that still returns it.
    const raw = await applications.findDocument(orgA, document.id);
    expect(raw?.storageKey).toMatch(
      new RegExp(`^${orgA}/${application.id}/${document.id}/`),
    );
  });

  // ---------------------------------------------------------------------
  // Rejections — none may create a received document or an orphan file
  // ---------------------------------------------------------------------

  it('rejects a disallowed MIME type without writing any file', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;

    await expect(
      service.upload(
        orgA,
        application.id,
        docTypeId,
        pdfFile({ mimetype: 'application/zip' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.fileCount()).toBe(0);
  });

  it('rejects a file over the size limit without writing any file', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;

    await expect(
      service.upload(
        orgA,
        application.id,
        docTypeId,
        pdfFile({ size: MAX_ODC_UPLOAD_BYTES + 1 }),
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(storage.fileCount()).toBe(0);
  });

  it('rejects an upload for an application belonging to another organization, without writing any file', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;

    await expect(
      service.upload(orgB, application.id, docTypeId, pdfFile()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.fileCount()).toBe(0);
  });

  it('rejects an upload while the application is not draft/incomplete/in_review, without writing any file', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;
    // Force a terminal status directly (no legitimate path reaches it here,
    // but this is exactly the guard resolveAddableDocumentType() enforces).
    prisma.odcApplication.update({
      where: { id: application.id },
      data: { status: 'withdrawn' },
    });

    await expect(
      service.upload(orgA, application.id, docTypeId, pdfFile()),
    ).rejects.toBeInstanceOf(Error);
    expect(storage.fileCount()).toBe(0);
  });

  it('rejects a document type that does not belong to the program, without writing any file', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);

    await expect(
      service.upload(orgA, application.id, 'not-a-real-doc-type', pdfFile()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.fileCount()).toBe(0);
  });

  // RC-33 hardening — the file write can succeed and the OdcDocument row's
  // own DB write can still fail afterwards. This must never leave an
  // orphan file: OdcDocumentsService.upload() rolls the write back via
  // OdcStorage.delete() before re-throwing the original error.
  it('deletes the just-written file when persisting the document row fails after a successful write', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;
    const dbError = new Error('DB connection dropped');
    const originalCreate = prisma.odcDocument.create;
    prisma.odcDocument.create = jest.fn(() => {
      throw dbError;
    }) as typeof prisma.odcDocument.create;

    await expect(
      service.upload(orgA, application.id, docTypeId, pdfFile()),
    ).rejects.toBe(dbError);

    expect(storage.fileCount()).toBe(0);
    prisma.odcDocument.create = originalCreate;
  });

  // The rollback's own delete() failing must never mask the original DB
  // error — the caller still sees the DB failure, not a storage error.
  it('surfaces the original DB error even when the rollback delete() itself fails', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;
    const dbError = new Error('DB connection dropped');
    prisma.odcDocument.create = jest.fn(() => {
      throw dbError;
    }) as typeof prisma.odcDocument.create;
    storage.delete = jest.fn(() =>
      Promise.reject(new Error('disk unavailable')),
    );

    await expect(
      service.upload(orgA, application.id, docTypeId, pdfFile()),
    ).rejects.toBe(dbError);
  });

  // ---------------------------------------------------------------------
  // Download — always 404, never a crash, never leaks another org's data
  // ---------------------------------------------------------------------

  it('getFile() 404s (never 403) for a document in another organization', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;
    const result = await service.upload(
      orgA,
      application.id,
      docTypeId,
      pdfFile(),
    );

    await expect(
      service.getFile(orgB, result.documents[0].id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getFile() 404s for a document id that does not exist', async () => {
    await expect(
      service.getFile(orgA, 'does-not-exist'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // Regression guard for RC-32's demo seed: its documents are 'received' in
  // the database with a canonical-but-never-written storageKey (RC-33
  // hardening switched the seed to addUploadedDocument() with a real
  // organizationId/applicationId/documentId-shaped key — see
  // odc-demo-seed.ts). This must 404 cleanly, never throw an unhandled
  // error, purely because OdcStorage.get() itself finds nothing.
  it('getFile() 404s cleanly for a received document whose storageKey has no real file (e.g. the RC-32 demo seed)', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;
    const { application: withSeedKey } = await applications.addUploadedDocument(
      orgA,
      application.id,
      {
        id: 'doc-seed',
        documentTypeId: docTypeId,
        originalName: 'cv-demo.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storageKey: `${orgA}/${application.id}/doc-seed/cv-demo.pdf`,
      },
    );
    const seedDocument = withSeedKey.documents[0];
    expect(seedDocument.status).toBe('received');

    await expect(service.getFile(orgA, seedDocument.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // RC-33 hardening — the canonical-ownership guard itself. No code path
  // can create a row like this any more (storageKey can no longer be
  // client-supplied, and addUploadedDocument() only ever receives its own
  // freshly-built canonical key) — this simulates a pre-hardening or
  // otherwise tampered row directly at the fake-DB layer, the only way such
  // a row could still exist, and proves getFile() refuses it rather than
  // trusting the DB's own storageKey column blindly.
  it('getFile() 404s a received document whose storageKey does not canonically belong to it, and never even reads storage', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;
    await storage.put(
      `${orgB}/other-app/other-doc/secret.pdf`,
      Buffer.from('x'),
    );
    prisma.documents.set('doc-mismatched', {
      id: 'doc-mismatched',
      organizationId: orgA,
      applicationId: application.id,
      documentTypeId: docTypeId,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1,
      status: 'received',
      storageKey: `${orgB}/other-app/other-doc/secret.pdf`,
      createdAt: new Date(),
    });
    const getSpy = jest.spyOn(storage, 'get');

    await expect(
      service.getFile(orgA, 'doc-mismatched'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(getSpy).not.toHaveBeenCalled();
  });

  // Codex review — a plain `startsWith(prefix)` accepted this because the
  // string literally starts with the expected prefix; path.resolve()
  // (LocalOdcStorage.resolveWithinRoot()) would then normalize the
  // embedded `..` segments and walk straight out to a different
  // organization/application/document, never leaving the overall storage
  // root — so the root-boundary check alone never caught it either. The
  // canonical, segment-by-segment check in storageKeyBelongsTo() (see its
  // own spec for the exhaustive unit coverage) must refuse this before
  // storage is ever touched.
  it('getFile() 404s a traversal storageKey that only superficially starts with the expected prefix, and never reads storage', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;
    const traversalKey = `${orgA}/${application.id}/doc-traversal/../../../${orgB}/other-app/other-doc/secret.pdf`;
    await storage.put(
      `${orgB}/other-app/other-doc/secret.pdf`,
      Buffer.from('very secret'),
    );
    prisma.documents.set('doc-traversal', {
      id: 'doc-traversal',
      organizationId: orgA,
      applicationId: application.id,
      documentTypeId: docTypeId,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1,
      status: 'received',
      storageKey: traversalKey,
      createdAt: new Date(),
    });
    const getSpy = jest.spyOn(storage, 'get');

    await expect(service.getFile(orgA, 'doc-traversal')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('getFile() 404s for a document still pending_upload', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;
    const pending = await applications.addDocument(orgA, application.id, {
      documentTypeId: docTypeId,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });

    await expect(
      service.getFile(orgA, pending.documents[0].id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
