import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  OdcApplicationsService,
  type OdcApplicationWithRelations,
} from './odc-applications.service';
import {
  OdcDocumentsService,
  type OdcUploadFileInput,
} from './odc-documents.service';
import { checkCompleteness } from './odc-completeness';
import { renderNotificationTemplate } from '../notifications/notification-templates';
import {
  NOTIFICATION_TRANSPORT,
  type NotificationTransport,
} from '../notifications/notification-transport';
import { StartOdcApplicationDto } from './dto/start-odc-application.dto';
import { UpdateOdcApplicationDto } from './dto/update-odc-application.dto';
import { WithdrawApplicationDto } from './dto/withdraw-application.dto';

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const COOLDOWN_MS = 60_000;
const MIN_RESPONSE_DELAY_MS = 300;
// A public write (answers/upload) is only ever allowed while the candidate
// can still change something a screening pass would re-evaluate. This is
// deliberately narrower than what the internal service methods themselves
// allow (updateAnswers()/upload() still let *staff* touch an 'in_review'
// application) — the extra restriction lives here, in front of them, never
// inside them, so staff behavior is completely unchanged.
const PUBLIC_WRITABLE_STATUSES = ['draft', 'incomplete'];

const RESPONSE_NOT_FOUND = () =>
  new NotFoundException('Candidature non trouvée.');

export interface StartOdcApplicationResult {
  expiresAt: Date;
  emailSent: boolean;
  magicToken?: string;
}

export interface PublicOdcProgramView {
  name: string;
  description: string | null;
  status: string;
  fields: Array<{
    id: string;
    key: string;
    label: string;
    required: boolean;
    fieldType: string;
    options: unknown;
    sortOrder: number;
  }>;
  documentTypes: Array<{
    id: string;
    key: string;
    label: string;
    required: boolean;
    mimeAllow: string[];
  }>;
}

export interface PublicOdcApplicationView {
  id: string;
  status: string;
  answers: Record<string, unknown>;
  missing: string[];
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  documents: Array<{
    id: string;
    documentTypeId: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
    createdAt: Date;
  }>;
  program: PublicOdcProgramView;
}

/**
 * RC-49 — the ODC public candidate portal. No JwtAuthGuard/OrgScopeGuard
 * here (see OdcPublicController): an applicant with no RobIA account
 * authenticates with a per-application magic-link token instead of a JWT.
 *
 * Non-negotiable boundaries, enforced only here (never relaxed on the
 * OdcApplicationsService/OdcDocumentsService side, which stay exactly as
 * they were for the staff controller):
 *   - decide(), scores, outreach, listByProgram, program open/close/create
 *     are never reachable from this service — it simply has no method that
 *     calls them.
 *   - A wrong/expired/foreign token always resolves to 404, never 403 — see
 *     resolveSession().
 *   - organizationId is always derived from the program (start()) or the
 *     session (every other method) — never accepted from a request body.
 *   - Every response DTO here is an explicit allowlist (PublicOdcProgramView
 *     / PublicOdcApplicationView) — never the raw Prisma row, so a future
 *     field added to OdcApplication/OdcProgram can never leak through this
 *     surface by accident.
 */
@Injectable()
export class OdcPublicService {
  private readonly logger = new Logger(OdcPublicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly applications: OdcApplicationsService,
    private readonly documents: OdcDocumentsService,
    private readonly config: ConfigService,
    @Inject(NOTIFICATION_TRANSPORT)
    private readonly transport: NotificationTransport,
  ) {}

  // -----------------------------------------------------------------------
  // Program (read-only, public form definition)
  // -----------------------------------------------------------------------

  async getProgram(publicKey: string): Promise<PublicOdcProgramView> {
    const program = await this.prisma.odcProgram.findFirst({
      where: { publicKey },
      include: { fields: true, docTypes: true },
    });
    if (!program || program.status !== 'open') {
      throw RESPONSE_NOT_FOUND();
    }
    return this.toPublicProgramView(program);
  }

  // -----------------------------------------------------------------------
  // Start / resume
  // -----------------------------------------------------------------------

  // Mirrors AuthService.forgotPassword()'s own shape closely: a single
  // response regardless of whether the email/application already existed,
  // a 60s cooldown per (email, program) so repeated calls never re-send or
  // re-issue, and a floor delay so the response time itself never becomes a
  // side channel for "does this email already have a dossier here".
  //
  // The program-not-found/not-open checks below run *before* any of that —
  // a program's own status is public information already exposed by
  // getProgram(), so there is nothing to protect by delaying or masking it.
  async start(
    publicKey: string,
    dto: StartOdcApplicationDto,
  ): Promise<StartOdcApplicationResult> {
    const startedAt = Date.now();
    try {
      const program = await this.prisma.odcProgram.findFirst({
        where: { publicKey },
      });
      if (!program) {
        throw RESPONSE_NOT_FOUND();
      }
      if (program.status !== 'open') {
        throw new ConflictException(
          `This program is "${program.status}" — new applications can only be started while it is "open".`,
        );
      }

      const email = dto.email.trim().toLowerCase();

      // Reuse an existing applicant for this exact (organization, email)
      // rather than ever creating a second one — this is what keeps "one
      // dossier per (program, email)" true even across repeated start()
      // calls, since the real uniqueness constraint is on
      // (programId, applicantId), not directly on email.
      let applicant = await this.prisma.odcApplicant.findFirst({
        where: { organizationId: program.organizationId, email },
      });
      if (!applicant) {
        applicant = await this.applications.createApplicant(
          program.organizationId,
          { displayName: dto.displayName, email },
        );
      }

      let application = await this.prisma.odcApplication.findFirst({
        where: {
          organizationId: program.organizationId,
          programId: program.id,
          applicantId: applicant.id,
        },
      });
      if (!application) {
        application = await this.applications.createApplication(
          program.organizationId,
          program.id,
          { applicantId: applicant.id },
        );
      }
      const applicationId = application.id;

      // Cooldown — checked against whatever session row (expired or not)
      // was last created for this application, *before* any invalidation
      // below ever removes it. A hit returns the exact same response shape
      // as a fresh issuance, just without touching anything.
      const cooldownSince = new Date(Date.now() - COOLDOWN_MS);
      const recentSession = await this.prisma.odcApplicantSession.findFirst({
        where: { applicationId, createdAt: { gte: cooldownSince } },
      });
      if (recentSession) {
        return {
          expiresAt: recentSession.expiresAt,
          emailSent: false,
        };
      }

      const token = randomBytes(32).toString('hex');
      const tokenHash = this.hashToken(token);
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

      // Invalidate every non-expired session for this application before
      // issuing the new one — at most one usable token per application.
      await this.prisma.odcApplicantSession.deleteMany({
        where: { applicationId, expiresAt: { gt: new Date() } },
      });
      await this.prisma.odcApplicantSession.create({
        data: {
          organizationId: program.organizationId,
          applicationId,
          tokenHash,
          expiresAt,
        },
      });

      const emailSent = await this.sendMagicLink(
        email,
        dto.displayName,
        program.name,
        token,
      );

      const result: StartOdcApplicationResult = { expiresAt, emailSent };
      if (
        process.env.NODE_ENV === 'test' &&
        process.env.ODC_PUBLIC_RETURN_TOKEN === '1'
      ) {
        result.magicToken = token;
      }
      return result;
    } finally {
      const remainingDelay = MIN_RESPONSE_DELAY_MS - (Date.now() - startedAt);
      if (remainingDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingDelay));
      }
    }
  }

  // RC-32 convention — example.com is IANA-reserved (RFC 2606) and can
  // never resolve to a real inbox; a caller testing/demoing against it must
  // never actually reach the SMTP transport. Any other domain goes through
  // the same RC-26 transport/template path as every other ROBIA email —
  // if the transport isn't configured (NotificationsDisabledError /
  // IncompleteSmtpConfigurationError) or delivery fails, this is logged and
  // swallowed, never thrown: start() always returns its one generic
  // response regardless of whether the email actually went out.
  private async sendMagicLink(
    email: string,
    applicantName: string,
    programName: string,
    token: string,
  ): Promise<boolean> {
    if (email.endsWith('@example.com')) {
      return false;
    }
    try {
      this.transport.ensureReady();
    } catch (error) {
      this.logger.warn(
        'ODC public portal: notification transport unavailable, magic link email skipped',
        error instanceof Error ? error.message : undefined,
      );
      return false;
    }
    try {
      const magicLinkUrl = this.buildMagicLinkUrl(token);
      const rendered = renderNotificationTemplate('odc_applicant_magic_link', {
        applicantName: clip(applicantName),
        programName: clip(programName),
        magicLinkUrl,
      });
      await this.transport.sendEmail({
        to: email,
        subject: rendered.subject,
        text: rendered.text,
      });
      return true;
    } catch (error) {
      this.logger.warn(
        'ODC public portal: magic link email delivery failed',
        error instanceof Error ? error.message : undefined,
      );
      return false;
    }
  }

  private buildMagicLinkUrl(token: string): string {
    const base = (
      this.config.get<string>('ODC_PUBLIC_PORTAL_URL') ??
      `${(this.config.get<string>('APP_URL') ?? this.config.get<string>('FRONTEND_URL') ?? 'https://app.robiacopilot.site').replace(/\/$/, '')}/odc/candidature`
    ).replace(/\/$/, '');
    const link = new URL(base);
    link.searchParams.set('token', token);
    return link.toString();
  }

  // -----------------------------------------------------------------------
  // Session-authenticated routes
  // -----------------------------------------------------------------------

  async getApplication(token: string): Promise<PublicOdcApplicationView> {
    const { application } = await this.resolveSession(token);
    return this.toPublicApplicationView(application);
  }

  async updateAnswers(
    token: string,
    dto: UpdateOdcApplicationDto,
  ): Promise<PublicOdcApplicationView> {
    const { session, application } = await this.resolveSession(token);
    this.assertPublicWritable(application.status);
    const updated = await this.applications.updateAnswers(
      session.organizationId,
      application.id,
      dto,
    );
    return this.toPublicApplicationView(updated);
  }

  async upload(
    token: string,
    documentTypeId: string,
    file: OdcUploadFileInput,
  ): Promise<PublicOdcApplicationView> {
    const { session, application } = await this.resolveSession(token);
    this.assertPublicWritable(application.status);
    const updated = await this.documents.upload(
      session.organizationId,
      application.id,
      documentTypeId,
      file,
    );
    return this.toPublicApplicationView(updated);
  }

  // submit()'s own internal guard (only ever runs from 'draft') is already
  // at least as strict as PUBLIC_WRITABLE_STATUSES, so no extra check is
  // added in front of it here — see OdcApplicationsService.submit().
  async submit(token: string): Promise<PublicOdcApplicationView> {
    const { session, application } = await this.resolveSession(token);
    const updated = await this.applications.submit(
      session.organizationId,
      null,
      application.id,
    );
    return this.toPublicApplicationView(updated);
  }

  // Deliberately *not* gated by PUBLIC_WRITABLE_STATUSES — a candidate can
  // withdraw from in_review/waitlisted too (withdraw() itself already
  // refuses only a genuinely terminal application: accepted/rejected/
  // already withdrawn — see its own doc comment).
  async withdraw(
    token: string,
    dto: WithdrawApplicationDto,
  ): Promise<PublicOdcApplicationView> {
    const { session, application } = await this.resolveSession(token);
    const updated = await this.applications.withdraw(
      session.organizationId,
      null,
      application.id,
      dto,
    );
    return this.toPublicApplicationView(updated);
  }

  // -----------------------------------------------------------------------
  // Shared helpers
  // -----------------------------------------------------------------------

  private assertPublicWritable(status: string): void {
    if (!PUBLIC_WRITABLE_STATUSES.includes(status)) {
      throw new ConflictException(
        `This dossier can no longer be edited from the public portal (current status: "${status}").`,
      );
    }
  }

  // Never 403: a wrong token, an expired one, or one that happens to belong
  // to a different application are all indistinguishable from "this
  // resource does not exist" from the outside — see docs/RC49_ODC_PUBLIC_PORTAL.md.
  private async resolveSession(token: string): Promise<{
    session: { organizationId: string; applicationId: string };
    application: OdcApplicationWithRelations;
  }> {
    if (!token || token.trim().length === 0) {
      throw RESPONSE_NOT_FOUND();
    }
    const tokenHash = this.hashToken(token);
    const session = await this.prisma.odcApplicantSession.findFirst({
      where: { tokenHash },
    });
    if (!session || !this.hashesMatch(session.tokenHash, tokenHash)) {
      throw RESPONSE_NOT_FOUND();
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw RESPONSE_NOT_FOUND();
    }
    const application = await this.applications.getApplication(
      session.organizationId,
      session.applicationId,
    );
    return { session, application };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  // Defense in depth on top of the DB-level exact-match lookup above: a
  // byte-length-safe, constant-time re-check that the row `findFirst` just
  // returned really does carry the hash we computed, never a plain `===`.
  // Both operands are always 32-byte SHA-256 hex digests (64 hex chars) —
  // never unequal-length input reaching timingSafeEqual.
  private hashesMatch(storedHash: string, computedHash: string): boolean {
    const stored = Buffer.from(storedHash, 'hex');
    const computed = Buffer.from(computedHash, 'hex');
    if (stored.length !== computed.length) return false;
    return timingSafeEqual(stored, computed);
  }

  private toPublicProgramView(program: {
    name: string;
    description: string | null;
    status: string;
    fields: Array<{
      id: string;
      key: string;
      label: string;
      required: boolean;
      fieldType: string;
      options: unknown;
      sortOrder: number;
    }>;
    docTypes: Array<{
      id: string;
      key: string;
      label: string;
      required: boolean;
      mimeAllow: string[];
    }>;
  }): PublicOdcProgramView {
    return {
      name: program.name,
      description: program.description,
      status: program.status,
      fields: program.fields.map((field) => ({
        id: field.id,
        key: field.key,
        label: field.label,
        required: field.required,
        fieldType: field.fieldType,
        options: field.options,
        sortOrder: field.sortOrder,
      })),
      documentTypes: program.docTypes.map((docType) => ({
        id: docType.id,
        key: docType.key,
        label: docType.label,
        required: docType.required,
        mimeAllow: docType.mimeAllow,
      })),
    };
  }

  private toPublicApplicationView(
    application: OdcApplicationWithRelations,
  ): PublicOdcApplicationView {
    const missing = checkCompleteness(
      application.program.fields,
      application.program.docTypes,
      application.answers as Record<string, unknown>,
      application.documents,
    ).missing;
    return {
      id: application.id,
      status: application.status,
      answers: application.answers as Record<string, unknown>,
      missing,
      submittedAt: application.submittedAt,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
      documents: application.documents.map((doc) => ({
        id: doc.id,
        documentTypeId: doc.documentTypeId,
        originalName: doc.originalName,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        status: doc.status,
        createdAt: doc.createdAt,
      })),
      program: this.toPublicProgramView(application.program),
    };
  }
}

const MAX_NAME_LENGTH = 80;

function clip(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_NAME_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}
