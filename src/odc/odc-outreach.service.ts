import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { maskEmail } from '../notifications/mask-email';
import { redactSensitive } from '../common/logging/redact';
import { renderNotificationTemplate } from '../notifications/notification-templates';
import {
  NOTIFICATION_TRANSPORT,
  NotificationsDisabledError,
  IncompleteSmtpConfigurationError,
  type NotificationTransport,
} from '../notifications/notification-transport';
import { QueueOdcOutreachDto } from './dto/queue-odc-outreach.dto';

const ELIGIBLE_STATUSES = ['in_review', 'waitlisted'];
const TEMPLATE_KEY = 'odc_candidate_invite';
const MAX_NAME_LENGTH = 80;

export type OdcOutreachPublic = {
  id: string;
  programId: string;
  applicationId: string;
  sortOrder: number;
  status: string;
  templateKey: string;
  applicantName: string;
  recipientMasked: string;
  sentAt: Date | null;
  lastError: string | null;
  isNext: boolean;
};

/**
 * RC-31 — rank CVs, queue a human-approved one-by-one email sequence.
 * Never writes accepted/rejected/waitlisted. Recipient is always
 * OdcApplicant.email resolved server-side.
 */
@Injectable()
export class OdcOutreachService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_TRANSPORT)
    private readonly transport: NotificationTransport,
  ) {}

  async list(
    organizationId: string,
    programId: string,
  ): Promise<OdcOutreachPublic[]> {
    await this.requireProgram(organizationId, programId);
    const rows = await this.prisma.odcOutreach.findMany({
      where: { organizationId, programId },
      include: { application: { include: { applicant: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    const nextId = this.nextSendableId(rows);
    return rows.map((row) => this.toPublic(row, nextId));
  }

  async queue(
    organizationId: string,
    programId: string,
    dto: QueueOdcOutreachDto,
  ): Promise<OdcOutreachPublic[]> {
    const program = await this.requireProgram(organizationId, programId);
    const uniqueIds = [...new Set(dto.applicationIds)];
    if (uniqueIds.length !== dto.applicationIds.length) {
      throw new BadRequestException(
        'applicationIds must not contain duplicates.',
      );
    }

    const applications = await this.prisma.odcApplication.findMany({
      where: { organizationId, programId, id: { in: uniqueIds } },
      include: { applicant: true },
    });
    if (applications.length !== uniqueIds.length) {
      throw new NotFoundException(
        'One or more applications were not found in this program.',
      );
    }
    const byId = new Map(applications.map((row) => [row.id, row]));

    for (const id of uniqueIds) {
      const application = byId.get(id);
      if (!application) {
        throw new NotFoundException(
          'One or more applications were not found in this program.',
        );
      }
      if (!ELIGIBLE_STATUSES.includes(application.status)) {
        throw new ConflictException(
          `Application ${id} cannot be queued ` +
            `(status "${application.status}"). ` +
            'Eligible: in_review, waitlisted.',
        );
      }
      const email = application.applicant.email?.trim() ?? '';
      if (!email) {
        throw new ConflictException(
          `Applicant "${application.applicant.displayName}" ` +
            'has no email on file.',
        );
      }
    }

    const existingCount = await this.prisma.odcOutreach.count({
      where: { organizationId, programId },
    });

    try {
      await this.prisma.$transaction(
        uniqueIds.map((applicationId, index) =>
          this.prisma.odcOutreach.create({
            data: {
              organizationId,
              programId,
              applicationId,
              sortOrder: existingCount + index + 1,
              status: 'queued',
              templateKey: TEMPLATE_KEY,
            },
          }),
        ),
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'At least one selected application is already in the outreach queue.',
        );
      }
      throw error;
    }

    await this.prisma.odcHistoryEvent.createMany({
      data: uniqueIds.map((applicationId) => {
        const application = byId.get(applicationId);
        const status = application?.status ?? 'in_review';
        return {
          organizationId,
          applicationId,
          actorUserId: null,
          eventType: 'odc.outreach.queued',
          fromStatus: status,
          toStatus: status,
          payload: {
            programId,
            programName: program.name,
          },
        };
      }),
    });

    return this.list(organizationId, programId);
  }

  async send(
    organizationId: string,
    userId: string,
    outreachId: string,
  ): Promise<OdcOutreachPublic> {
    const outreach = await this.prisma.odcOutreach.findFirst({
      where: { id: outreachId, organizationId },
      include: {
        application: { include: { applicant: true } },
        program: true,
      },
    });
    if (!outreach) {
      throw new NotFoundException('Outreach non trouvé.');
    }

    const queue = await this.prisma.odcOutreach.findMany({
      where: { organizationId, programId: outreach.programId },
      include: { application: { include: { applicant: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    const nextId = this.nextSendableId(queue);
    if (nextId !== outreach.id) {
      throw new ConflictException(
        'Emails must be sent one by one, in queue order. ' +
          'This is not the next item.',
      );
    }

    const email = outreach.application.applicant.email?.trim() ?? '';
    if (!email) {
      throw new ConflictException('Applicant has no email on file.');
    }

    const templateData = {
      applicantName: clip(outreach.application.applicant.displayName),
      programName: clip(outreach.program.name),
    };
    const rendered = renderNotificationTemplate(TEMPLATE_KEY, templateData);

    try {
      this.transport.ensureReady();
      await this.transport.sendEmail({
        to: email,
        subject: rendered.subject,
        text: rendered.text,
      });
    } catch (error) {
      const message =
        error instanceof NotificationsDisabledError ||
        error instanceof IncompleteSmtpConfigurationError
          ? error.message
          : 'Email delivery failed.';
      await this.prisma.odcOutreach.update({
        where: { id: outreach.id },
        data: {
          status: 'failed',
          lastError: String(redactSensitive(message)),
        },
      });
      throw new ConflictException(message);
    }

    const updated = await this.prisma.odcOutreach.update({
      where: { id: outreach.id },
      data: {
        status: 'sent',
        approvedById: userId,
        sentAt: new Date(),
        lastError: null,
      },
      include: { application: { include: { applicant: true } } },
    });

    await this.prisma.odcHistoryEvent.create({
      data: {
        organizationId,
        applicationId: outreach.applicationId,
        actorUserId: userId,
        eventType: 'odc.outreach.sent',
        fromStatus: outreach.application.status,
        toStatus: outreach.application.status,
        payload: { outreachId: outreach.id, recipientMasked: maskEmail(email) },
      },
    });

    const refreshed = await this.prisma.odcOutreach.findMany({
      where: { organizationId, programId: outreach.programId },
      include: { application: { include: { applicant: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    return this.toPublic(updated, this.nextSendableId(refreshed));
  }

  async skip(
    organizationId: string,
    userId: string,
    outreachId: string,
  ): Promise<OdcOutreachPublic> {
    const outreach = await this.prisma.odcOutreach.findFirst({
      where: { id: outreachId, organizationId },
      include: { application: { include: { applicant: true } } },
    });
    if (!outreach) {
      throw new NotFoundException('Outreach non trouvé.');
    }
    if (outreach.status === 'sent') {
      throw new ConflictException('A sent email cannot be skipped.');
    }

    const updated = await this.prisma.odcOutreach.update({
      where: { id: outreach.id },
      data: { status: 'skipped', approvedById: userId },
      include: { application: { include: { applicant: true } } },
    });

    await this.prisma.odcHistoryEvent.create({
      data: {
        organizationId,
        applicationId: outreach.applicationId,
        actorUserId: userId,
        eventType: 'odc.outreach.skipped',
        fromStatus: outreach.application.status,
        toStatus: outreach.application.status,
        payload: { outreachId: outreach.id },
      },
    });

    const queue = await this.prisma.odcOutreach.findMany({
      where: { organizationId, programId: outreach.programId },
      include: { application: { include: { applicant: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    return this.toPublic(updated, this.nextSendableId(queue));
  }

  private nextSendableId(
    rows: Array<{ id: string; status: string; sortOrder: number }>,
  ): string | null {
    const next = [...rows]
      .filter((row) => row.status === 'queued' || row.status === 'failed')
      .sort((a, b) => a.sortOrder - b.sortOrder)[0];
    return next?.id ?? null;
  }

  private async requireProgram(organizationId: string, programId: string) {
    const program = await this.prisma.odcProgram.findFirst({
      where: { id: programId, organizationId },
    });
    if (!program) {
      throw new NotFoundException('Program non trouvé.');
    }
    return program;
  }

  private toPublic(
    row: {
      id: string;
      programId: string;
      applicationId: string;
      sortOrder: number;
      status: string;
      templateKey: string;
      sentAt: Date | null;
      lastError: string | null;
      application: { applicant: { displayName: string; email: string | null } };
    },
    nextId: string | null,
  ): OdcOutreachPublic {
    const email = row.application.applicant.email ?? '';
    return {
      id: row.id,
      programId: row.programId,
      applicationId: row.applicationId,
      sortOrder: row.sortOrder,
      status: row.status,
      templateKey: row.templateKey,
      applicantName: row.application.applicant.displayName,
      recipientMasked: email ? maskEmail(email) : '',
      sentAt: row.sentAt,
      lastError: row.lastError,
      isNext: nextId === row.id,
    };
  }
}

function clip(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_NAME_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_NAME_LENGTH);
}
