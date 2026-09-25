import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { storageKeyBelongsTo } from './storage/odc-storage-key';
import { CreateOdcApplicantDto } from './dto/create-odc-applicant.dto';
import { CreateOdcApplicationDto } from './dto/create-odc-application.dto';
import { UpdateOdcApplicationDto } from './dto/update-odc-application.dto';
import { CreateOdcDocumentDto } from './dto/create-odc-document.dto';
import { ProposeSummaryDto } from './dto/propose-summary.dto';
import { ProposeScoresDto } from './dto/propose-scores.dto';
import { UpdateScoresDto } from './dto/update-scores.dto';
import { DecideApplicationDto } from './dto/decide-application.dto';
import { WithdrawApplicationDto } from './dto/withdraw-application.dto';
import { checkCompleteness, computeWeightedTotal } from './odc-completeness';
import {
  ODC_APPLICATION_DECIDED_EVENT,
  ODC_APPLICATION_INCOMPLETE_EVENT,
  ODC_APPLICATION_READY_FOR_REVIEW_EVENT,
  ODC_APPLICATION_SUBMITTED_EVENT,
  ODC_DOCUMENT_RECEIVED_EVENT,
  type OdcApplicationDecidedEvent,
  type OdcApplicationIncompleteEvent,
  type OdcApplicationReadyForReviewEvent,
  type OdcApplicationSubmittedEvent,
  type OdcDocumentReceivedEvent,
} from './odc-events';

// Once a candidature reaches one of these, nothing in this service ever
// moves it again — decide()/withdraw() both refuse a terminal application,
// and every action-triggered path (prepareApplicationSummary,
// recomputeMissingDocuments) treats a terminal application as "nothing to
// do" rather than an error, so an automation racing a human decision can
// never fight it.
const TERMINAL_STATUSES = ['accepted', 'rejected', 'withdrawn'];
const DECIDABLE_STATUSES = ['in_review', 'waitlisted'];

// RC-33 hardening — storageKey deliberately excluded: it is an internal
// filesystem-key implementation detail, never something a frontend or API
// caller needs to render a document list, and never safe to hand back to a
// client (see docs/RC33_ODC_STORAGE_HARDENING.md). Every application
// response — getApplication, listByProgram, addDocument, addUploadedDocument
// — shares this exact select, so a document row can never leak its
// storageKey through any of them. A real download only ever goes through
// GET /documents/:documentId/file, which resolves the key itself,
// server-side, from OdcApplicationsService.findDocument() (a separate,
// narrower query that still selects storageKey for that one purpose).
const ODC_DOCUMENT_PUBLIC_SELECT = {
  id: true,
  organizationId: true,
  applicationId: true,
  documentTypeId: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  status: true,
  createdAt: true,
} satisfies Prisma.OdcDocumentSelect;

export type OdcApplicationWithRelations = Prisma.OdcApplicationGetPayload<{
  include: {
    documents: { select: typeof ODC_DOCUMENT_PUBLIC_SELECT };
    scoreLines: true;
    events: true;
    applicant: true;
    program: { include: { fields: true; criteria: true; docTypes: true } };
  };
}>;

/**
 * RC-29 — the candidature lifecycle itself: applicants, applications,
 * documents, deterministic screening, proposed vs. final scores, the one
 * human-only decide() route, withdrawal, and an append-only history. See
 * docs/RC29_ODC_CANDIDATURES.md for the full state machine and the
 * non-negotiable rule this whole service exists to enforce: only decide()
 * ever writes accepted/rejected/waitlisted, and only for a human caller
 * (OdcController requires JwtAuthGuard — there is no path into decide()
 * from OpsActionsRegistryService, since no `robia.odc.decide` action is
 * ever registered there).
 */
@Injectable()
export class OdcApplicationsService {
  private readonly logger = new Logger(OdcApplicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------------
  // Applicants
  // ---------------------------------------------------------------------

  async createApplicant(organizationId: string, dto: CreateOdcApplicantDto) {
    return this.prisma.odcApplicant.create({
      data: {
        organizationId,
        displayName: dto.displayName,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
      },
    });
  }

  // ---------------------------------------------------------------------
  // Applications — creation
  // ---------------------------------------------------------------------

  async createApplication(
    organizationId: string,
    programId: string,
    dto: CreateOdcApplicationDto,
  ): Promise<OdcApplicationWithRelations> {
    const program = await this.prisma.odcProgram.findFirst({
      where: { id: programId, organizationId },
    });
    if (!program) {
      throw new NotFoundException('Program non trouvé.');
    }
    if (program.status !== 'open') {
      throw new ConflictException(
        `This program is "${program.status}" — new applications can only be created while it is "open".`,
      );
    }
    const applicant = await this.prisma.odcApplicant.findFirst({
      where: { id: dto.applicantId, organizationId },
    });
    if (!applicant) {
      throw new NotFoundException('Applicant non trouvé.');
    }

    try {
      const application = await this.prisma.odcApplication.create({
        data: {
          organizationId,
          programId,
          applicantId: dto.applicantId,
        },
      });
      return this.getApplication(organizationId, application.id);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'This applicant already has an application for this program.',
        );
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Applications — read
  // ---------------------------------------------------------------------

  async getApplication(
    organizationId: string,
    id: string,
  ): Promise<OdcApplicationWithRelations> {
    const application = await this.prisma.odcApplication.findFirst({
      where: { id, organizationId },
      include: {
        documents: { select: ODC_DOCUMENT_PUBLIC_SELECT },
        scoreLines: true,
        events: { orderBy: { createdAt: 'asc' } },
        applicant: true,
        program: { include: { fields: true, criteria: true, docTypes: true } },
      },
    });
    if (!application) {
      throw new NotFoundException('Application non trouvée.');
    }
    return application;
  }

  async listByProgram(organizationId: string, programId: string) {
    const program = await this.prisma.odcProgram.findFirst({
      where: { id: programId, organizationId },
    });
    if (!program) {
      throw new NotFoundException('Program non trouvé.');
    }
    const rows = await this.prisma.odcApplication.findMany({
      where: { organizationId, programId },
      include: {
        applicant: true,
        documents: { select: ODC_DOCUMENT_PUBLIC_SELECT },
        scoreLines: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    return rankApplicationsByScore(rows);
  }

  async getHistory(organizationId: string, id: string) {
    const application = await this.getApplication(organizationId, id);
    return application.events;
  }

  // ---------------------------------------------------------------------
  // Applications — answers & documents
  // ---------------------------------------------------------------------

  async updateAnswers(
    organizationId: string,
    id: string,
    dto: UpdateOdcApplicationDto,
  ): Promise<OdcApplicationWithRelations> {
    const application = await this.getApplication(organizationId, id);
    if (!['draft', 'incomplete'].includes(application.status)) {
      throw new ConflictException(
        `Answers can only be edited while the application is "draft" or "incomplete" (current: "${application.status}").`,
      );
    }
    // Merged, never replaced — a PATCH carrying only the fields a candidate
    // just filled in must never wipe answers already saved earlier.
    const mergedAnswers = {
      ...(application.answers as Record<string, unknown>),
      ...dto.answers,
    };
    await this.prisma.odcApplication.update({
      where: { id },
      data: { answers: mergedAnswers as Prisma.InputJsonValue },
    });
    return this.getApplication(organizationId, id);
  }

  // Metadata-only path — no file ever passes through here and no
  // storageKey is ever accepted (see CreateOdcDocumentDto's own doc
  // comment): this only ever registers a 'pending_upload' placeholder slot
  // for a document type. The real upload path (addUploadedDocument() below,
  // via POST .../documents/upload) is the only way a document ever reaches
  // 'received'.
  //
  // RC-33 hardening — multiple-documents policy: at most one document per
  // (application, documentType) slot (see OdcDocument's own @@unique). This
  // metadata-only route never silently discards an occupied slot — unlike
  // addUploadedDocument(), it never touches OdcStorage, so it has no way to
  // clean up a real file a 'received' occupant might already point at.
  // Only a real upload (which does own that cleanup) may replace a slot;
  // this route simply refuses when one is already taken.
  async addDocument(
    organizationId: string,
    id: string,
    dto: CreateOdcDocumentDto,
  ): Promise<OdcApplicationWithRelations> {
    const application = await this.getApplication(organizationId, id);
    const docType = this.resolveAddableDocumentType(
      application,
      dto.documentTypeId,
    );
    await this.assertSlotFree(id, docType.id);

    await this.prisma.odcDocument.create({
      data: {
        organizationId,
        applicationId: id,
        documentTypeId: docType.id,
        originalName: dto.originalName,
        mimeType: dto.mimeType,
        sizeBytes: dto.sizeBytes,
        storageKey: null,
        status: 'pending_upload',
      },
    });

    return this.getApplication(organizationId, id);
  }

  // RC-33 — the real-upload path. Called only by OdcDocumentsService, only
  // after it has already written the file to OdcStorage and confirmed
  // `exists()` is true — so unlike addDocument() above, this never accepts
  // a "no file yet" state: status is always 'received'. `input.id` is the
  // same id OdcDocumentsService already embedded in the storage key
  // (buildOdcStorageKey's {documentId} segment), passed through so the
  // OdcDocument row's own id always matches the key that was actually
  // written — never a second, independently generated id.
  //
  // RC-33 hardening — multiple-documents policy: atomic replacement. If a
  // document already occupies this (application, documentType) slot
  // (received or still pending_upload), it is deleted in the same
  // transaction that creates the new row — there is never a moment with
  // zero or two rows for a slot, and a caller can never need to pick among
  // several documents of the same type. The previous occupant's own
  // storageKey (if it had one) is returned so the caller — the only layer
  // that owns OdcStorage — can delete that now-orphaned file once this
  // transaction has actually committed, never before.
  async addUploadedDocument(
    organizationId: string,
    id: string,
    input: {
      id: string;
      documentTypeId: string;
      originalName: string;
      mimeType: string;
      sizeBytes: number;
      storageKey: string;
    },
  ): Promise<{
    application: OdcApplicationWithRelations;
    replacedStorageKey: string | null;
  }> {
    const application = await this.getApplication(organizationId, id);
    const docType = this.resolveAddableDocumentType(
      application,
      input.documentTypeId,
    );

    const replacedDocument = await this.prisma.$transaction(async (tx) => {
      const occupant = await tx.odcDocument.findFirst({
        where: { applicationId: id, documentTypeId: docType.id },
      });
      if (occupant) {
        await tx.odcDocument.delete({ where: { id: occupant.id } });
      }
      await tx.odcDocument.create({
        data: {
          id: input.id,
          organizationId,
          applicationId: id,
          documentTypeId: docType.id,
          originalName: input.originalName,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          storageKey: input.storageKey,
          status: 'received',
        },
      });
      return occupant;
    });

    // RC-33 hardening (Codex review) — the row just replaced may predate
    // this RC's own hardening: its storageKey was never guaranteed to
    // canonically belong to *that* row's own organization/application/id
    // (a client could once supply an arbitrary one — see
    // CreateOdcDocumentDto's own history). Deleting it unconditionally
    // would let a stale, tampered row make this replacement delete a
    // completely different organization's real file. The key is only
    // ever handed back for deletion when it demonstrably belongs to the
    // document it is actually being deleted for; a non-canonical key is
    // never touched — left on disk, and logged so an operator can find
    // and clean it up by hand.
    let replacedStorageKey: string | null = null;
    if (replacedDocument?.storageKey) {
      if (
        storageKeyBelongsTo(
          replacedDocument.storageKey,
          replacedDocument.organizationId,
          replacedDocument.applicationId,
          replacedDocument.id,
        )
      ) {
        replacedStorageKey = replacedDocument.storageKey;
      } else {
        this.logger.warn(
          `ODC : document remplacé (id=${replacedDocument.id}) dont le storageKey n'appartient pas canoniquement à cette ligne — fichier NON supprimé, à nettoyer manuellement.`,
        );
      }
    }

    const payload: OdcDocumentReceivedEvent = {
      organizationId,
      applicationId: id,
      documentId: input.id,
      documentTypeId: docType.id,
    };
    this.events.emit(ODC_DOCUMENT_RECEIVED_EVENT, payload);

    return {
      application: await this.getApplication(organizationId, id),
      replacedStorageKey,
    };
  }

  // Shared guard for addDocument()'s own slot-occupied check — a plain
  // findFirst + throw, never relying on the DB's unique constraint alone
  // to surface a clean ConflictException instead of a raw P2002.
  private async assertSlotFree(
    applicationId: string,
    documentTypeId: string,
  ): Promise<void> {
    const existing = await this.prisma.odcDocument.findFirst({
      where: { applicationId, documentTypeId },
    });
    if (existing) {
      throw new ConflictException(
        'A document already exists for this document type — only a real upload can replace it.',
      );
    }
  }

  // Called only by OdcDocumentsService.upload(), *before* it writes
  // anything to OdcStorage — the same status/docType checks
  // addUploadedDocument() itself re-checks on the way in, run early enough
  // that a rejection here never leaves an orphan file on disk. Throws
  // exactly like addDocument()/addUploadedDocument() do; returns the
  // resolved docType so the caller can validate its own MIME allowlist too.
  async assertDocumentAddable(
    organizationId: string,
    applicationId: string,
    documentTypeId: string,
  ) {
    const application = await this.getApplication(
      organizationId,
      applicationId,
    );
    return this.resolveAddableDocumentType(application, documentTypeId);
  }

  // Called only by OdcDocumentsService.getFile() — a raw, single-document
  // lookup (no application/program join needed for a download). Returns
  // null rather than throwing: the caller decides what a missing/foreign
  // document means for its own response (always 404, never 403 — see
  // docs/RC33_ODC_UPLOAD.md).
  async findDocument(organizationId: string, documentId: string) {
    return this.prisma.odcDocument.findFirst({
      where: { id: documentId, organizationId },
    });
  }

  // Shared by addDocument() and addUploadedDocument() — the exact same
  // status/docType-membership checks regardless of which path a document
  // arrives through, so the two can never silently diverge.
  private resolveAddableDocumentType(
    application: OdcApplicationWithRelations,
    documentTypeId: string,
  ) {
    if (!['draft', 'incomplete', 'in_review'].includes(application.status)) {
      throw new ConflictException(
        `Documents can only be added while the application is "draft", "incomplete" or "in_review" (current: "${application.status}").`,
      );
    }
    const docType = application.program.docTypes.find(
      (dt) => dt.id === documentTypeId,
    );
    if (!docType) {
      throw new NotFoundException(
        "This document type does not belong to the application's program.",
      );
    }
    return docType;
  }

  // ---------------------------------------------------------------------
  // Submission & deterministic screening
  // ---------------------------------------------------------------------

  // RC-49 — `userId` is nullable so the public portal (no RobIA account) can
  // call the exact same submit() a staff caller does, rather than forking
  // the state machine. A real id always means a staff actor; null always
  // means the applicant themself — see resolveActor().
  async submit(
    organizationId: string,
    userId: string | null,
    id: string,
  ): Promise<OdcApplicationWithRelations> {
    const application = await this.getApplication(organizationId, id);
    if (application.status !== 'draft') {
      throw new BadRequestException(
        `An application can only be submitted from "draft" (current: "${application.status}").`,
      );
    }

    const actor = resolveActor(userId);
    const now = new Date();
    await this.prisma.odcApplication.update({
      where: { id },
      data: { status: 'submitted', submittedAt: now },
    });
    await this.recordHistory(organizationId, id, {
      actorUserId: actor.actorUserId,
      actorType: actor.actorType,
      eventType: 'submitted',
      fromStatus: 'draft',
      toStatus: 'submitted',
    });
    const submittedPayload: OdcApplicationSubmittedEvent = {
      organizationId,
      applicationId: id,
      programId: application.programId,
    };
    this.events.emit(ODC_APPLICATION_SUBMITTED_EVENT, submittedPayload);

    await this.prisma.odcApplication.update({
      where: { id },
      data: { status: 'screening' },
    });
    await this.recordHistory(organizationId, id, {
      actorType: 'system',
      eventType: 'screening_started',
      fromStatus: 'submitted',
      toStatus: 'screening',
    });

    await this.runScreening(organizationId, id, application, 'screening');
    return this.getApplication(organizationId, id);
  }

  // Shared by submit()'s own screening pass and
  // recomputeMissingDocuments()'s later re-check (robia.odc.flag_missing_documents)
  // — the exact same deterministic check, the exact same transition/event on
  // becoming complete, so the outcome never depends on which path triggered
  // it. `fromStatus` is the status the application is transitioning FROM
  // right now (submit(): 'screening'; recheck: 'incomplete').
  private async runScreening(
    organizationId: string,
    id: string,
    application: OdcApplicationWithRelations,
    fromStatus: string,
  ): Promise<void> {
    const result = checkCompleteness(
      application.program.fields,
      application.program.docTypes,
      application.answers as Record<string, unknown>,
      application.documents,
    );

    if (result.complete) {
      await this.prisma.odcApplication.update({
        where: { id },
        data: { status: 'in_review', missing: Prisma.JsonNull },
      });
      await this.recordHistory(organizationId, id, {
        actorType: 'system',
        eventType: 'screening_passed',
        fromStatus,
        toStatus: 'in_review',
      });
      const payload: OdcApplicationReadyForReviewEvent = {
        organizationId,
        applicationId: id,
      };
      this.events.emit(ODC_APPLICATION_READY_FOR_REVIEW_EVENT, payload);
    } else {
      await this.prisma.odcApplication.update({
        where: { id },
        data: {
          status: 'incomplete',
          missing: result.missing,
        },
      });
      await this.recordHistory(organizationId, id, {
        actorType: 'system',
        eventType: 'screening_failed',
        fromStatus,
        toStatus: 'incomplete',
        payload: { missing: result.missing },
      });
      const payload: OdcApplicationIncompleteEvent = {
        organizationId,
        applicationId: id,
        missing: result.missing,
      };
      this.events.emit(ODC_APPLICATION_INCOMPLETE_EVENT, payload);
    }
  }

  // Called only by robia.odc.flag_missing_documents (see
  // OpsActionsRegistryService) — never by a controller route. A no-op,
  // never an error, when the application isn't currently 'incomplete': an
  // automation re-checking a candidature a human already moved on from must
  // never fight that outcome or crash the run.
  async recomputeMissingDocuments(
    organizationId: string,
    applicationId: string,
  ): Promise<{ changed: boolean; application: OdcApplicationWithRelations }> {
    const application = await this.getApplication(
      organizationId,
      applicationId,
    );
    if (application.status !== 'incomplete') {
      return { changed: false, application };
    }
    await this.runScreening(
      organizationId,
      applicationId,
      application,
      'incomplete',
    );
    const fresh = await this.getApplication(organizationId, applicationId);
    return { changed: fresh.status !== application.status, application: fresh };
  }

  // ---------------------------------------------------------------------
  // Summary & scores
  // ---------------------------------------------------------------------

  async proposeSummary(
    organizationId: string,
    id: string,
    dto: ProposeSummaryDto,
  ): Promise<OdcApplicationWithRelations> {
    const application = await this.getApplication(organizationId, id);
    this.assertNotTerminal(application);
    await this.prisma.odcApplication.update({
      where: { id },
      data: { summaryDraft: dto.summaryDraft },
    });
    return this.getApplication(organizationId, id);
  }

  // Called only by robia.odc.prepare_application_summary. Never an LLM call
  // in this RC (no such integration exists yet — see
  // docs/RC29_ODC_CANDIDATURES.md's residual risks): a short, deterministic,
  // entirely-from-already-persisted-data summary, exactly the kind of
  // "never fabricate a total/score" discipline this whole domain applies
  // elsewhere. A terminal application is a silent no-op, same reasoning as
  // recomputeMissingDocuments().
  async prepareApplicationSummary(
    organizationId: string,
    applicationId: string,
  ): Promise<{ skipped: boolean; summaryDraft: string | null }> {
    const application = await this.getApplication(
      organizationId,
      applicationId,
    );
    if (TERMINAL_STATUSES.includes(application.status)) {
      return { skipped: true, summaryDraft: application.summaryDraft };
    }
    const answeredFields = application.program.fields.filter((field) => {
      const value = (application.answers as Record<string, unknown>)[field.key];
      return value !== undefined && value !== null && value !== '';
    });
    const receivedDocuments = application.documents.filter(
      (doc) => doc.status === 'received',
    );
    const summaryDraft =
      `Candidature de ${application.applicant.displayName} au programme ` +
      `« ${application.program.name} » : ${answeredFields.length}/${application.program.fields.length} ` +
      `champ(s) renseigné(s), ${receivedDocuments.length}/${application.program.docTypes.length} ` +
      `pièce(s) reçue(s).`;
    await this.prisma.odcApplication.update({
      where: { id: applicationId },
      data: { summaryDraft },
    });
    return { skipped: false, summaryDraft };
  }

  async proposeScores(
    organizationId: string,
    id: string,
    dto: ProposeScoresDto,
  ): Promise<OdcApplicationWithRelations> {
    const application = await this.getApplication(organizationId, id);
    this.assertNotTerminal(application);
    const criteriaById = new Map(
      application.program.criteria.map((criterion) => [
        criterion.id,
        criterion,
      ]),
    );
    for (const line of dto.scores) {
      if (!criteriaById.has(line.criterionId)) {
        throw new BadRequestException(
          `Criterion "${line.criterionId}" does not belong to this application's program.`,
        );
      }
    }

    await this.prisma.$transaction(
      dto.scores.map((line) =>
        this.prisma.odcScoreLine.upsert({
          where: {
            applicationId_criterionId: {
              applicationId: id,
              criterionId: line.criterionId,
            },
          },
          create: {
            organizationId,
            applicationId: id,
            criterionId: line.criterionId,
            proposedPoints: line.proposedPoints,
            proposedBy: line.proposedBy ?? 'ai',
            rationale: line.rationale ?? null,
          },
          update: {
            proposedPoints: line.proposedPoints,
            proposedBy: line.proposedBy ?? 'ai',
            rationale: line.rationale ?? null,
          },
        }),
      ),
    );

    await this.recomputeTotals(id, application.program.criteria);
    return this.getApplication(organizationId, id);
  }

  async updateFinalScores(
    organizationId: string,
    id: string,
    dto: UpdateScoresDto,
  ): Promise<OdcApplicationWithRelations> {
    const application = await this.getApplication(organizationId, id);
    this.assertNotTerminal(application);
    const criteriaById = new Map(
      application.program.criteria.map((criterion) => [
        criterion.id,
        criterion,
      ]),
    );
    for (const line of dto.scores) {
      if (!criteriaById.has(line.criterionId)) {
        throw new BadRequestException(
          `Criterion "${line.criterionId}" does not belong to this application's program.`,
        );
      }
    }

    await this.prisma.$transaction(
      dto.scores.map((line) =>
        this.prisma.odcScoreLine.upsert({
          where: {
            applicationId_criterionId: {
              applicationId: id,
              criterionId: line.criterionId,
            },
          },
          create: {
            organizationId,
            applicationId: id,
            criterionId: line.criterionId,
            finalPoints: line.finalPoints,
          },
          update: { finalPoints: line.finalPoints },
        }),
      ),
    );

    await this.recomputeTotals(id, application.program.criteria);
    return this.getApplication(organizationId, id);
  }

  // Recomputes both totals from whatever OdcScoreLine rows exist right now
  // — never incrementally, so a total can never drift from what the lines
  // actually say. Null (not 0) whenever a required criterion's own points
  // are still unset — see odc-completeness.ts. `criteria` is always the
  // caller's own already-fetched application.program.criteria — never
  // re-queried, since the caller already has it.
  private async recomputeTotals(
    applicationId: string,
    criteria: Array<{ id: string; weight: number; required: boolean }>,
  ): Promise<void> {
    const lines = await this.prisma.odcScoreLine.findMany({
      where: { applicationId },
    });

    const proposedTotal = computeWeightedTotal(
      criteria,
      lines.map((line) => ({
        criterionId: line.criterionId,
        points: line.proposedPoints,
      })),
    );
    const finalTotal = computeWeightedTotal(
      criteria,
      lines.map((line) => ({
        criterionId: line.criterionId,
        points: line.finalPoints,
      })),
    );

    await this.prisma.odcApplication.update({
      where: { id: applicationId },
      data: { proposedTotal, finalTotal },
    });
  }

  // ---------------------------------------------------------------------
  // Decision (human-only) & withdrawal
  // ---------------------------------------------------------------------

  async decide(
    organizationId: string,
    userId: string,
    id: string,
    dto: DecideApplicationDto,
  ): Promise<OdcApplicationWithRelations> {
    const application = await this.getApplication(organizationId, id);
    if (!DECIDABLE_STATUSES.includes(application.status)) {
      throw new BadRequestException(
        `A decision can only be made from "in_review" or "waitlisted" (current: "${application.status}").`,
      );
    }
    // Re-checked here even though DecideApplicationDto already validates
    // non-empty — a rule this load-bearing (the one and only door to
    // accepted/rejected) is never trusted to a single layer.
    if (!dto.decisionReason || dto.decisionReason.trim().length === 0) {
      throw new BadRequestException('decisionReason is required.');
    }

    const fromStatus = application.status;
    await this.prisma.odcApplication.update({
      where: { id },
      data: {
        status: dto.decision,
        decidedAt: new Date(),
        decidedById: userId,
        decisionReason: dto.decisionReason,
      },
    });
    await this.recordHistory(organizationId, id, {
      actorUserId: userId,
      actorType: 'staff',
      eventType: 'decided',
      fromStatus,
      toStatus: dto.decision,
      payload: { decisionReason: dto.decisionReason },
    });
    const payload: OdcApplicationDecidedEvent = {
      organizationId,
      applicationId: id,
      decision: dto.decision,
      decidedById: userId,
    };
    this.events.emit(ODC_APPLICATION_DECIDED_EVENT, payload);

    return this.getApplication(organizationId, id);
  }

  // RC-49 — same nullable-actor treatment as submit() above: the public
  // portal calls this exact method with userId=null so a candidate can
  // withdraw their own dossier without a RobIA account, never a forked
  // withdrawal path.
  async withdraw(
    organizationId: string,
    userId: string | null,
    id: string,
    dto: WithdrawApplicationDto,
  ): Promise<OdcApplicationWithRelations> {
    const application = await this.getApplication(organizationId, id);
    if (TERMINAL_STATUSES.includes(application.status)) {
      throw new ConflictException(
        `An application already "${application.status}" cannot be withdrawn.`,
      );
    }
    const actor = resolveActor(userId);
    const fromStatus = application.status;
    await this.prisma.odcApplication.update({
      where: { id },
      data: { status: 'withdrawn' },
    });
    await this.recordHistory(organizationId, id, {
      actorUserId: actor.actorUserId,
      actorType: actor.actorType,
      eventType: 'withdrawn',
      fromStatus,
      toStatus: 'withdrawn',
      payload: { reason: dto.reason },
    });
    // No event in the RC-20 sense: 'withdrawn' is not one of the 5
    // documented eventTypes (see odc-events.ts) — withdrawal is recorded in
    // history only.
    return this.getApplication(organizationId, id);
  }

  // ---------------------------------------------------------------------
  // Actions-registry helper
  // ---------------------------------------------------------------------

  // Called only by robia.odc.create_review_task. The title is always
  // computed here, never caller-supplied — see that action's own doc
  // comment in OpsActionsRegistryService.
  async createReviewTask(
    organizationId: string,
    applicationId: string,
  ): Promise<{ actionItemId: string; title: string }> {
    const application = await this.getApplication(
      organizationId,
      applicationId,
    );
    const title = `Revue de candidature — ${application.applicant.displayName} (${application.program.name})`;
    const actionItem = await this.prisma.actionItem.create({
      data: { organizationId, title, status: 'todo' },
    });
    return { actionItemId: actionItem.id, title: actionItem.title };
  }

  // ---------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------

  private assertNotTerminal(application: OdcApplicationWithRelations): void {
    if (TERMINAL_STATUSES.includes(application.status)) {
      throw new ConflictException(
        `This application is already "${application.status}" — no further scoring or summary is possible.`,
      );
    }
  }

  private async recordHistory(
    organizationId: string,
    applicationId: string,
    entry: {
      actorUserId?: string | null;
      actorType: OdcHistoryActorType;
      eventType: string;
      fromStatus: string | null;
      toStatus: string | null;
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.prisma.odcHistoryEvent.create({
      data: {
        organizationId,
        applicationId,
        actorUserId: entry.actorUserId ?? null,
        actorType: entry.actorType,
        eventType: entry.eventType,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        payload: (entry.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });
  }
}

type OdcHistoryActorType = 'staff' | 'system' | 'applicant';

// A real id always means the staff-only, JWT-guarded controller called in —
// null always means the public portal did (see OdcPublicService), which has
// no RobIA account/userId to attribute the action to at all. There is no
// third caller of submit()/withdraw(), so this mapping is exhaustive.
function resolveActor(userId: string | null): {
  actorUserId: string | null;
  actorType: OdcHistoryActorType;
} {
  return userId
    ? { actorUserId: userId, actorType: 'staff' }
    : { actorUserId: null, actorType: 'applicant' };
}

function rankApplicationsByScore<
  T extends {
    finalTotal: number | null;
    submittedAt: Date | null;
    updatedAt: Date;
  },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.finalTotal === null && b.finalTotal === null) {
      return compareDatesDesc(
        a.submittedAt ?? a.updatedAt,
        b.submittedAt ?? b.updatedAt,
      );
    }
    if (a.finalTotal === null) return 1;
    if (b.finalTotal === null) return -1;
    if (b.finalTotal !== a.finalTotal) return b.finalTotal - a.finalTotal;
    return compareDatesDesc(
      a.submittedAt ?? a.updatedAt,
      b.submittedAt ?? b.updatedAt,
    );
  });
}

function compareDatesDesc(a: Date, b: Date): number {
  return new Date(b).getTime() - new Date(a).getTime();
}
