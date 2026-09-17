import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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

export type OdcApplicationWithRelations = Prisma.OdcApplicationGetPayload<{
  include: {
    documents: true;
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
        documents: true,
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
    return this.prisma.odcApplication.findMany({
      where: { organizationId, programId },
      include: {
        applicant: true,
        documents: true,
        scoreLines: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
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

  async addDocument(
    organizationId: string,
    id: string,
    dto: CreateOdcDocumentDto,
  ): Promise<OdcApplicationWithRelations> {
    const application = await this.getApplication(organizationId, id);
    if (!['draft', 'incomplete', 'in_review'].includes(application.status)) {
      throw new ConflictException(
        `Documents can only be added while the application is "draft", "incomplete" or "in_review" (current: "${application.status}").`,
      );
    }
    const docType = application.program.docTypes.find(
      (dt) => dt.id === dto.documentTypeId,
    );
    if (!docType) {
      throw new NotFoundException(
        "This document type does not belong to the application's program.",
      );
    }

    // storageKey is optional in v1 (no real upload backend wired up yet —
    // see docs/RC29_ODC_CANDIDATURES.md): its presence alone decides
    // whether this document already counts toward completeness.
    const status = dto.storageKey ? 'received' : 'pending_upload';
    const document = await this.prisma.odcDocument.create({
      data: {
        organizationId,
        applicationId: id,
        documentTypeId: dto.documentTypeId,
        originalName: dto.originalName,
        mimeType: dto.mimeType,
        sizeBytes: dto.sizeBytes,
        storageKey: dto.storageKey ?? null,
        status,
      },
    });

    if (status === 'received') {
      const payload: OdcDocumentReceivedEvent = {
        organizationId,
        applicationId: id,
        documentId: document.id,
        documentTypeId: dto.documentTypeId,
      };
      this.events.emit(ODC_DOCUMENT_RECEIVED_EVENT, payload);
    }

    return this.getApplication(organizationId, id);
  }

  // ---------------------------------------------------------------------
  // Submission & deterministic screening
  // ---------------------------------------------------------------------

  async submit(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<OdcApplicationWithRelations> {
    const application = await this.getApplication(organizationId, id);
    if (application.status !== 'draft') {
      throw new BadRequestException(
        `An application can only be submitted from "draft" (current: "${application.status}").`,
      );
    }

    const now = new Date();
    await this.prisma.odcApplication.update({
      where: { id },
      data: { status: 'submitted', submittedAt: now },
    });
    await this.recordHistory(organizationId, id, {
      actorUserId: userId,
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

  async withdraw(
    organizationId: string,
    userId: string,
    id: string,
    dto: WithdrawApplicationDto,
  ): Promise<OdcApplicationWithRelations> {
    const application = await this.getApplication(organizationId, id);
    if (TERMINAL_STATUSES.includes(application.status)) {
      throw new ConflictException(
        `An application already "${application.status}" cannot be withdrawn.`,
      );
    }
    const fromStatus = application.status;
    await this.prisma.odcApplication.update({
      where: { id },
      data: { status: 'withdrawn' },
    });
    await this.recordHistory(organizationId, id, {
      actorUserId: userId,
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
      actorUserId?: string;
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
        eventType: entry.eventType,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        payload: (entry.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });
  }
}
