import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { OdcApplicationsService } from './odc-applications.service';
import { PrismaService } from '../prisma/prisma.service';
import { FakeOdcPrisma, type FakeRecord } from './test-support/fake-odc-prisma';
import {
  ODC_APPLICATION_DECIDED_EVENT,
  ODC_APPLICATION_INCOMPLETE_EVENT,
  ODC_APPLICATION_READY_FOR_REVIEW_EVENT,
  ODC_APPLICATION_SUBMITTED_EVENT,
  ODC_DOCUMENT_RECEIVED_EVENT,
} from './odc-events';

function baseEvents() {
  return { emit: jest.fn() };
}

describe('OdcApplicationsService', () => {
  const orgA = 'org-a';
  const orgB = 'org-b';
  const userA = 'user-a';

  let prisma: FakeOdcPrisma;
  let events: { emit: jest.Mock };
  let service: OdcApplicationsService;

  beforeEach(() => {
    prisma = new FakeOdcPrisma();
    events = baseEvents();
    service = new OdcApplicationsService(
      prisma as unknown as PrismaService,
      events as never,
    );
  });

  function createProgram(
    organizationId: string,
    overrides: Partial<{
      status: string;
      fields: FakeRecord[];
      criteria: FakeRecord[];
      docTypes: FakeRecord[];
    }> = {},
  ) {
    return prisma.odcProgram.create({
      data: {
        organizationId,
        slug: 'programme-1',
        name: 'Programme 1',
        createdById: userA,
        status: overrides.status ?? 'open',
        fields: {
          create: overrides.fields ?? [
            {
              key: 'motivation',
              label: 'Motivation',
              required: true,
              fieldType: 'longtext',
            },
          ],
        },
        criteria: { create: overrides.criteria ?? [] },
        docTypes: {
          create: overrides.docTypes ?? [
            { key: 'id_card', label: "Pièce d'identité", required: true },
          ],
        },
      },
      include: { fields: true, criteria: true, docTypes: true },
    }) as FakeRecord & {
      id: string;
      fields: FakeRecord[];
      criteria: FakeRecord[];
      docTypes: FakeRecord[];
    };
  }

  function createApplicant(organizationId: string) {
    return prisma.odcApplicant.create({
      data: { organizationId, displayName: 'Jane Doe' },
    }) as FakeRecord & { id: string };
  }

  async function createDraftApplication(
    organizationId: string,
    programId: string,
  ) {
    const applicant = createApplicant(organizationId);
    return service.createApplication(organizationId, programId, {
      applicantId: applicant.id,
    });
  }

  // ---------------------------------------------------------------------
  // Isolation
  // ---------------------------------------------------------------------

  it("never lets one organization read another organization's application", async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);

    await expect(
      service.getApplication(orgB, application.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ---------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------

  it('rejects creating an application for a program that is not "open"', async () => {
    const program = createProgram(orgA, { status: 'draft' });
    const applicant = createApplicant(orgA);
    await expect(
      service.createApplication(orgA, program.id, {
        applicantId: applicant.id,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a second application for the same applicant on the same program', async () => {
    const program = createProgram(orgA);
    const applicant = createApplicant(orgA);
    await service.createApplication(orgA, program.id, {
      applicantId: applicant.id,
    });
    await expect(
      service.createApplication(orgA, program.id, {
        applicantId: applicant.id,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // ---------------------------------------------------------------------
  // Answers
  // ---------------------------------------------------------------------

  it('merges answers instead of replacing them, and never wipes a previously-saved field', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    await service.updateAnswers(orgA, application.id, {
      answers: { motivation: 'first' },
    });
    const updated = await service.updateAnswers(orgA, application.id, {
      answers: { extra: 'second' },
    });
    expect(updated.answers).toEqual({ motivation: 'first', extra: 'second' });
  });

  it('rejects editing answers once the application is in_review', async () => {
    const program = createProgram(orgA, {
      fields: [],
      docTypes: [],
    });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id);
    await expect(
      service.updateAnswers(orgA, application.id, { answers: { x: 'y' } }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // ---------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------

  // RC-33 hardening — addDocument() (the public metadata-only JSON route)
  // can no longer accept a storageKey at all: CreateOdcDocumentDto has no
  // such field, so every document it creates is 'pending_upload', never
  // 'received'. See addUploadedDocument()'s own tests below for the only
  // path that ever reaches 'received'.
  it('addDocument() always creates a pending_upload document and never emits the received event', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;

    const result = await service.addDocument(orgA, application.id, {
      documentTypeId: docTypeId,
      originalName: 'id.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
    });

    expect(result.documents[0].status).toBe('pending_upload');
    expect(events.emit).not.toHaveBeenCalledWith(
      ODC_DOCUMENT_RECEIVED_EVENT,
      expect.anything(),
    );
  });

  // RC-33 hardening — a document row's storageKey must never be part of
  // any application response: it is an internal filesystem-key detail, not
  // something a caller needs (or should be able to use to probe another
  // organization's files). See ODC_DOCUMENT_PUBLIC_SELECT.
  it('never exposes storageKey on a document returned as part of an application', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;

    const { application: result } = await service.addUploadedDocument(
      orgA,
      application.id,
      {
        id: 'doc-no-leak',
        documentTypeId: docTypeId,
        originalName: 'cv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        storageKey: `${orgA}/${application.id}/doc-no-leak/uuid.pdf`,
      },
    );

    const document = result.documents.find(
      (d: FakeRecord) => d.id === 'doc-no-leak',
    );
    expect(document).toBeDefined();
    expect(document).not.toHaveProperty('storageKey');

    const fetched = await service.getApplication(orgA, application.id);
    expect(
      fetched.documents.find((d: FakeRecord) => d.id === 'doc-no-leak'),
    ).not.toHaveProperty('storageKey');
  });

  it("rejects a document whose type does not belong to the application's program", async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    await expect(
      service.addDocument(orgA, application.id, {
        documentTypeId: 'not-a-real-doc-type',
        originalName: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ---------------------------------------------------------------------
  // Uploaded documents (RC-33) — same rules as addDocument(), always received
  // ---------------------------------------------------------------------

  it('addUploadedDocument() always creates a received document, with the given id, and emits the event', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;

    const { application: result, replacedStorageKey } =
      await service.addUploadedDocument(orgA, application.id, {
        id: 'doc-fixed-id',
        documentTypeId: docTypeId,
        originalName: 'cv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 12_345,
        storageKey: `${orgA}/${application.id}/doc-fixed-id/uuid.pdf`,
      });

    expect(replacedStorageKey).toBeNull();
    const document = result.documents.find(
      (d: FakeRecord) => d.id === 'doc-fixed-id',
    );
    expect(document).toBeDefined();
    expect(document?.status).toBe('received');
    // storageKey itself is never exposed on the application response (see
    // ODC_DOCUMENT_PUBLIC_SELECT) — findDocument() is the one internal,
    // narrower query that still returns it, for getFile()'s own use.
    const raw = await service.findDocument(orgA, 'doc-fixed-id');
    expect(raw?.storageKey).toBe(
      `${orgA}/${application.id}/doc-fixed-id/uuid.pdf`,
    );
    expect(events.emit).toHaveBeenCalledWith(
      ODC_DOCUMENT_RECEIVED_EVENT,
      expect.objectContaining({
        applicationId: application.id,
        documentId: 'doc-fixed-id',
      }),
    );
  });

  // ---------------------------------------------------------------------
  // Multiple-documents policy (RC-33 hardening) — atomic replacement
  // ---------------------------------------------------------------------

  it('addUploadedDocument() atomically replaces an existing document for the same slot, keeping exactly one row', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;

    const { application: first } = await service.addUploadedDocument(
      orgA,
      application.id,
      {
        id: 'doc-v1',
        documentTypeId: docTypeId,
        originalName: 'cv-v1.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        storageKey: `${orgA}/${application.id}/doc-v1/11111111-1111-1111-1111-111111111111.pdf`,
      },
    );
    expect(first.documents).toHaveLength(1);
    expect(first.documents[0].id).toBe('doc-v1');

    const { application: second, replacedStorageKey } =
      await service.addUploadedDocument(orgA, application.id, {
        id: 'doc-v2',
        documentTypeId: docTypeId,
        originalName: 'cv-v2.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 200,
        storageKey: `${orgA}/${application.id}/doc-v2/22222222-2222-2222-2222-222222222222.pdf`,
      });

    // Exactly one document for this slot — never two, never zero — and it
    // is deterministically the new one, never ambiguous.
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0].id).toBe('doc-v2');
    expect(second.documents[0].originalName).toBe('cv-v2.pdf');
    // The replaced document's own storageKey was canonical for its own
    // identity (org-a/<application>/doc-v1/...), so it is handed back for
    // deletion.
    expect(replacedStorageKey).toBe(
      `${orgA}/${application.id}/doc-v1/11111111-1111-1111-1111-111111111111.pdf`,
    );
  });

  // Codex review — the exact scenario flagged: a historical row (created
  // before this RC's canonical-key enforcement existed) whose storageKey
  // was never validated against its own identity and happens to point at
  // a real file belonging to a *different* organization. Replacing it must
  // never hand that key back for deletion.
  it('addUploadedDocument() never returns a replaced storageKey that does not canonically belong to the document it came from', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;
    const orgBRealFileKey =
      'org-b/some-other-app/some-other-doc/33333333-3333-3333-3333-333333333333.pdf';

    // Simulate a pre-hardening row directly at the fake-DB layer — no
    // current code path can create one like this any more (storageKey can
    // no longer be client-supplied), which is exactly why this can only
    // ever be a historical artifact.
    prisma.odcDocument.create({
      data: {
        id: 'doc-historical',
        organizationId: orgA,
        applicationId: application.id,
        documentTypeId: docTypeId,
        originalName: 'old-cv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storageKey: orgBRealFileKey,
        status: 'received',
      },
    });

    const { application: replaced, replacedStorageKey } =
      await service.addUploadedDocument(orgA, application.id, {
        id: 'doc-new',
        documentTypeId: docTypeId,
        originalName: 'new-cv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 200,
        storageKey: `${orgA}/${application.id}/doc-new/44444444-4444-4444-4444-444444444444.pdf`,
      });

    // The new document is saved normally — the slot itself is still
    // atomically replaced (the historical row's own record is gone).
    expect(replaced.documents).toHaveLength(1);
    expect(replaced.documents[0].id).toBe('doc-new');
    // But org B's real file's key is never handed back for deletion.
    expect(replacedStorageKey).toBeNull();
  });

  it('addUploadedDocument() replacing a slot never disturbs a different document type', async () => {
    const program = createProgram(orgA, {
      docTypes: [
        { key: 'cv', label: 'CV', required: true },
        { key: 'id_card', label: "Pièce d'identité", required: true },
      ],
    });
    const application = await createDraftApplication(orgA, program.id);
    const cvTypeId = program.docTypes[0].id as string;
    const idTypeId = program.docTypes[1].id as string;

    await service.addUploadedDocument(orgA, application.id, {
      id: 'doc-cv',
      documentTypeId: cvTypeId,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      storageKey: `${orgA}/${application.id}/doc-cv/uuid.pdf`,
    });
    const { application: result } = await service.addUploadedDocument(
      orgA,
      application.id,
      {
        id: 'doc-id',
        documentTypeId: idTypeId,
        originalName: 'id.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 50,
        storageKey: `${orgA}/${application.id}/doc-id/uuid.pdf`,
      },
    );

    expect(result.documents).toHaveLength(2);
    expect(result.documents.map((d: FakeRecord) => d.id).sort()).toEqual([
      'doc-cv',
      'doc-id',
    ]);
  });

  it('addDocument() refuses to create a placeholder for a slot that is already occupied', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;
    await service.addUploadedDocument(orgA, application.id, {
      id: 'doc-existing',
      documentTypeId: docTypeId,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      storageKey: `${orgA}/${application.id}/doc-existing/uuid.pdf`,
    });

    await expect(
      service.addDocument(orgA, application.id, {
        documentTypeId: docTypeId,
        originalName: 'another.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('addUploadedDocument() enforces the same status/docType rules as addDocument()', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);

    await expect(
      service.addUploadedDocument(orgA, application.id, {
        id: 'doc-x',
        documentTypeId: 'not-a-real-doc-type',
        originalName: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        storageKey: 'k',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findDocument() only returns a document scoped to its own organization', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    const docTypeId = program.docTypes[0].id as string;
    await service.addUploadedDocument(orgA, application.id, {
      id: 'doc-fixed-id',
      documentTypeId: docTypeId,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1,
      storageKey: 'key',
    });

    expect(await service.findDocument(orgA, 'doc-fixed-id')).not.toBeNull();
    expect(await service.findDocument(orgB, 'doc-fixed-id')).toBeNull();
    expect(await service.findDocument(orgA, 'does-not-exist')).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Submit & screening
  // ---------------------------------------------------------------------

  it('submit() -> incomplete when a required document is missing', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    await service.updateAnswers(orgA, application.id, {
      answers: { motivation: 'yes' },
    });

    const result = await service.submit(orgA, userA, application.id);

    expect(result.status).toBe('incomplete');
    expect(result.missing).toContain('document:id_card');
    expect(events.emit).toHaveBeenCalledWith(
      ODC_APPLICATION_SUBMITTED_EVENT,
      expect.objectContaining({ applicationId: application.id }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      ODC_APPLICATION_INCOMPLETE_EVENT,
      expect.objectContaining({
        applicationId: application.id,
        missing: result.missing,
      }),
    );
  });

  it('submit() -> in_review when the application is already complete', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    await service.updateAnswers(orgA, application.id, {
      answers: { motivation: 'yes' },
    });
    await service.addUploadedDocument(orgA, application.id, {
      id: 'doc-submit-complete',
      documentTypeId: program.docTypes[0].id as string,
      originalName: 'id.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      storageKey: `${orgA}/${application.id}/doc-submit-complete/uuid.pdf`,
    });

    const result = await service.submit(orgA, userA, application.id);

    expect(result.status).toBe('in_review');
    expect(result.missing).toBeNull();
    expect(events.emit).toHaveBeenCalledWith(
      ODC_APPLICATION_READY_FOR_REVIEW_EVENT,
      expect.objectContaining({ applicationId: application.id }),
    );
  });

  it('records the full submitted -> screening -> outcome history for a single submit()', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const application = await createDraftApplication(orgA, program.id);

    await service.submit(orgA, userA, application.id);
    const history = await service.getHistory(orgA, application.id);

    expect(history.map((h) => h.eventType)).toEqual([
      'submitted',
      'screening_started',
      'screening_passed',
    ]);
    expect(history[0].fromStatus).toBe('draft');
    expect(history[0].toStatus).toBe('submitted');
    expect(history[0].actorUserId).toBe(userA);
  });

  it('rejects submit() from any status other than draft', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id);

    await expect(
      service.submit(orgA, userA, application.id),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('recomputeMissingDocuments(): a no-op, not an error, when the application is not "incomplete"', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id); // -> in_review directly

    const result = await service.recomputeMissingDocuments(
      orgA,
      application.id,
    );

    expect(result.changed).toBe(false);
    expect(result.application.status).toBe('in_review');
  });

  it('recomputeMissingDocuments(): moves incomplete -> in_review once the missing piece is provided, and emits ready_for_review', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    await service.updateAnswers(orgA, application.id, {
      answers: { motivation: 'yes' },
    });
    const submitted = await service.submit(orgA, userA, application.id);
    expect(submitted.status).toBe('incomplete');

    events.emit.mockClear();
    await service.addUploadedDocument(orgA, application.id, {
      id: 'doc-recompute-complete',
      documentTypeId: program.docTypes[0].id as string,
      originalName: 'id.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      storageKey: `${orgA}/${application.id}/doc-recompute-complete/uuid.pdf`,
    });
    const result = await service.recomputeMissingDocuments(
      orgA,
      application.id,
    );

    expect(result.changed).toBe(true);
    expect(result.application.status).toBe('in_review');
    expect(events.emit).toHaveBeenCalledWith(
      ODC_APPLICATION_READY_FOR_REVIEW_EVENT,
      expect.objectContaining({ applicationId: application.id }),
    );
  });

  // ---------------------------------------------------------------------
  // Scores
  // ---------------------------------------------------------------------

  it('propose-scores never writes finalPoints and never changes status', async () => {
    const program = createProgram(orgA, {
      fields: [],
      docTypes: [],
      criteria: [{ key: 'c1', label: 'Critère 1', weight: 2, required: true }],
    });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id); // -> in_review
    const criterionId = program.criteria[0].id as string;

    const result = await service.proposeScores(orgA, application.id, {
      scores: [{ criterionId, proposedPoints: 3 }],
    });

    expect(result.status).toBe('in_review');
    expect(result.scoreLines[0].finalPoints).toBeNull();
    expect(result.scoreLines[0].proposedPoints).toBe(3);
    expect(result.proposedTotal).toBe(6); // 3 * weight 2
    expect(result.finalTotal).toBeNull();
  });

  it('finalTotal stays null until every required criterion has finalPoints — never 0 by default', async () => {
    const program = createProgram(orgA, {
      fields: [],
      docTypes: [],
      criteria: [
        { key: 'c1', label: 'Critère 1', weight: 1, required: true },
        { key: 'c2', label: 'Critère 2', weight: 1, required: true },
      ],
    });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id);

    const partial = await service.updateFinalScores(orgA, application.id, {
      scores: [
        { criterionId: program.criteria[0].id as string, finalPoints: 4 },
      ],
    });
    expect(partial.finalTotal).toBeNull();

    const complete = await service.updateFinalScores(orgA, application.id, {
      scores: [
        { criterionId: program.criteria[1].id as string, finalPoints: 3 },
      ],
    });
    expect(complete.finalTotal).toBe(7);
  });

  it("rejects a score line for a criterion that does not belong to the application's program", async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id);

    await expect(
      service.proposeScores(orgA, application.id, {
        scores: [{ criterionId: 'not-a-real-criterion', proposedPoints: 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ---------------------------------------------------------------------
  // Decision (human-only)
  // ---------------------------------------------------------------------

  it('decide() without a reason -> 400, even bypassing DTO validation', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id);

    await expect(
      service.decide(orgA, userA, application.id, {
        decision: 'accepted',
        decisionReason: '',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('decide() from draft -> 400', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);

    await expect(
      service.decide(orgA, userA, application.id, {
        decision: 'accepted',
        decisionReason: 'Great fit',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('decide() accepted writes history from/to + decidedById, and emits the decided event', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id);

    const decided = await service.decide(orgA, userA, application.id, {
      decision: 'accepted',
      decisionReason: 'Great fit',
    });

    expect(decided.status).toBe('accepted');
    expect(decided.decidedById).toBe(userA);
    expect(decided.decisionReason).toBe('Great fit');
    const history = await service.getHistory(orgA, application.id);
    const decisionEvent = history.find((h) => h.eventType === 'decided');
    expect(decisionEvent?.fromStatus).toBe('in_review');
    expect(decisionEvent?.toStatus).toBe('accepted');
    expect(decisionEvent?.actorUserId).toBe(userA);
    expect(events.emit).toHaveBeenCalledWith(
      ODC_APPLICATION_DECIDED_EVENT,
      expect.objectContaining({
        applicationId: application.id,
        decision: 'accepted',
        decidedById: userA,
      }),
    );
  });

  it('decide() is also allowed from waitlisted', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id);
    await service.decide(orgA, userA, application.id, {
      decision: 'waitlisted',
      decisionReason: 'Strong but limited seats',
    });

    const decided = await service.decide(orgA, userA, application.id, {
      decision: 'accepted',
      decisionReason: 'A seat opened up',
    });
    expect(decided.status).toBe('accepted');
  });

  it('rejects a second decision once a candidature is already terminal', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id);
    await service.decide(orgA, userA, application.id, {
      decision: 'rejected',
      decisionReason: 'Not a fit',
    });

    await expect(
      service.decide(orgA, userA, application.id, {
        decision: 'accepted',
        decisionReason: 'Changed my mind',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ---------------------------------------------------------------------
  // Withdrawal
  // ---------------------------------------------------------------------

  it('withdraws a non-terminal application, recording the reason in history', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);

    const withdrawn = await service.withdraw(orgA, userA, application.id, {
      reason: 'Changed plans',
    });
    expect(withdrawn.status).toBe('withdrawn');
    const history = await service.getHistory(orgA, application.id);
    expect(history[history.length - 1]).toMatchObject({
      eventType: 'withdrawn',
      toStatus: 'withdrawn',
      payload: { reason: 'Changed plans' },
    });
  });

  it('rejects withdrawing an already-terminal application', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id);
    await service.decide(orgA, userA, application.id, {
      decision: 'accepted',
      decisionReason: 'Great fit',
    });

    await expect(
      service.withdraw(orgA, userA, application.id, { reason: 'Too late' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // ---------------------------------------------------------------------
  // Registry helpers
  // ---------------------------------------------------------------------

  it('createReviewTask() creates a draft/not_started ActionItem with a server-computed title', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);

    const { actionItemId, title } = await service.createReviewTask(
      orgA,
      application.id,
    );

    expect(title).toContain('Jane Doe');
    expect(title).toContain('Programme 1');
    const actionItem = prisma.actionItems.get(actionItemId);
    expect(actionItem).toMatchObject({
      approvalStatus: 'draft',
      executionStatus: 'not_started',
    });
  });

  it('prepareApplicationSummary() writes a deterministic summary from already-persisted data, never a decision', async () => {
    const program = createProgram(orgA);
    const application = await createDraftApplication(orgA, program.id);
    await service.updateAnswers(orgA, application.id, {
      answers: { motivation: 'yes' },
    });

    const result = await service.prepareApplicationSummary(
      orgA,
      application.id,
    );

    expect(result.skipped).toBe(false);
    expect(result.summaryDraft).toContain('Jane Doe');
    const fresh = await service.getApplication(orgA, application.id);
    expect(fresh.summaryDraft).toBe(result.summaryDraft);
    expect(fresh.status).toBe('draft');
  });

  it('prepareApplicationSummary() is a silent no-op on a terminal application', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id);
    await service.decide(orgA, userA, application.id, {
      decision: 'rejected',
      decisionReason: 'Not a fit',
    });

    const result = await service.prepareApplicationSummary(
      orgA,
      application.id,
    );
    expect(result.skipped).toBe(true);
  });

  it('proposeSummary()/proposeScores()/updateFinalScores() reject a terminal application', async () => {
    const program = createProgram(orgA, {
      fields: [],
      docTypes: [],
      criteria: [{ key: 'c1', label: 'Critère 1', required: true }],
    });
    const application = await createDraftApplication(orgA, program.id);
    await service.submit(orgA, userA, application.id);
    await service.decide(orgA, userA, application.id, {
      decision: 'rejected',
      decisionReason: 'Not a fit',
    });

    await expect(
      service.proposeSummary(orgA, application.id, { summaryDraft: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.proposeScores(orgA, application.id, {
        scores: [
          { criterionId: program.criteria[0].id as string, proposedPoints: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.updateFinalScores(orgA, application.id, {
        scores: [
          { criterionId: program.criteria[0].id as string, finalPoints: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('listByProgram() returns only applications of that program in the same org', async () => {
    const programA = createProgram(orgA, { fields: [], docTypes: [] });
    const programA2 = prisma.odcProgram.create({
      data: {
        organizationId: orgA,
        slug: 'programme-2',
        name: 'Programme 2',
        createdById: userA,
        status: 'open',
        fields: { create: [] },
        criteria: { create: [] },
        docTypes: { create: [] },
      },
      include: { fields: true, criteria: true, docTypes: true },
    }) as { id: string };
    const programB = createProgram(orgB, { fields: [], docTypes: [] });

    const inA = await createDraftApplication(orgA, programA.id);
    await createDraftApplication(orgA, programA2.id);
    await createDraftApplication(orgB, programB.id);

    const listed = await service.listByProgram(orgA, programA.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(inA.id);
    expect(listed[0].applicant).toBeDefined();
  });

  it('listByProgram() 404s for a program in another org', async () => {
    const programB = createProgram(orgB, { fields: [], docTypes: [] });
    await expect(
      service.listByProgram(orgA, programB.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
