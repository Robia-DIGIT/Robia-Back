import { ConflictException, NotFoundException } from '@nestjs/common';
import { OdcOutreachService } from './odc-outreach.service';
import { PrismaService } from '../prisma/prisma.service';
import { FakeOdcPrisma, type FakeRecord } from './test-support/fake-odc-prisma';
import { NotificationsDisabledError } from '../notifications/notification-transport';

describe('OdcOutreachService', () => {
  const orgA = 'org-a';
  const orgB = 'org-b';
  const userA = 'user-a';

  let prisma: FakeOdcPrisma;
  let transport: { ensureReady: jest.Mock; sendEmail: jest.Mock };
  let service: OdcOutreachService;

  beforeEach(() => {
    prisma = new FakeOdcPrisma();
    transport = {
      ensureReady: jest.fn(),
      sendEmail: jest.fn().mockResolvedValue({ providerMessageId: 'msg-1' }),
    };
    service = new OdcOutreachService(
      prisma as unknown as PrismaService,
      transport,
    );
  });

  function createProgram(organizationId: string) {
    return prisma.odcProgram.create({
      data: {
        organizationId,
        slug: 'odc-2026',
        name: 'ODC 2026',
        createdById: userA,
        status: 'open',
        fields: { create: [] },
        criteria: { create: [] },
        docTypes: { create: [] },
      },
      include: { fields: true, criteria: true, docTypes: true },
    }) as FakeRecord & { id: string; name: string };
  }

  function createInReview(
    organizationId: string,
    programId: string,
    name: string,
    email: string | null,
    finalTotal: number | null = null,
  ) {
    const applicant = prisma.odcApplicant.create({
      data: { organizationId, displayName: name, email },
    }) as FakeRecord & { id: string };
    const application = prisma.odcApplication.create({
      data: {
        organizationId,
        programId,
        applicantId: applicant.id,
        status: 'in_review',
        finalTotal,
      },
    }) as FakeRecord & { id: string };
    return application;
  }

  it('queues selected applications in order and masks emails', async () => {
    const program = createProgram(orgA);
    const first = createInReview(
      orgA,
      program.id,
      'Aina',
      'aina@example.com',
      80,
    );
    const second = createInReview(
      orgA,
      program.id,
      'Bema',
      'bema@example.com',
      70,
    );

    const queued = await service.queue(orgA, program.id, {
      applicationIds: [second.id, first.id],
    });

    expect(queued).toHaveLength(2);
    expect(queued[0].applicantName).toBe('Bema');
    expect(queued[0].sortOrder).toBe(1);
    expect(queued[0].isNext).toBe(true);
    expect(queued[0].recipientMasked).toBe('b***@example.com');
    expect(queued[1].applicantName).toBe('Aina');
    expect(queued[1].isNext).toBe(false);
    expect(JSON.stringify(queued)).not.toContain('aina@example.com');
  });

  it('refuses to queue a draft application or one without email', async () => {
    const program = createProgram(orgA);
    const draft = createInReview(orgA, program.id, 'Draft', 'd@example.com');
    prisma.odcApplication.update({
      where: { id: draft.id },
      data: { status: 'draft' },
    });
    const noMail = createInReview(orgA, program.id, 'Sans mail', null);

    await expect(
      service.queue(orgA, program.id, { applicationIds: [draft.id] }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.queue(orgA, program.id, { applicationIds: [noMail.id] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('sends only the next email and never writes accepted', async () => {
    const program = createProgram(orgA);
    const first = createInReview(orgA, program.id, 'Aina', 'aina@example.com');
    const second = createInReview(orgA, program.id, 'Bema', 'bema@example.com');
    const queued = await service.queue(orgA, program.id, {
      applicationIds: [first.id, second.id],
    });

    await expect(
      service.send(orgA, userA, queued[1].id),
    ).rejects.toBeInstanceOf(ConflictException);

    const sent = await service.send(orgA, userA, queued[0].id);
    expect(sent.status).toBe('sent');
    expect(sent.isNext).toBe(false);
    expect(transport.sendEmail).toHaveBeenCalledTimes(1);
    const sentPayload = JSON.stringify(transport.sendEmail.mock.calls);
    expect(sentPayload).toContain('aina@example.com');
    expect(sentPayload).toContain('ODC 2026');

    const application = prisma.odcApplication.findFirst({
      where: { id: first.id },
    }) as FakeRecord;
    expect(application.status).toBe('in_review');
  });

  it('skip moves to the next item without sending', async () => {
    const program = createProgram(orgA);
    const first = createInReview(orgA, program.id, 'Aina', 'aina@example.com');
    const second = createInReview(orgA, program.id, 'Bema', 'bema@example.com');
    const queued = await service.queue(orgA, program.id, {
      applicationIds: [first.id, second.id],
    });

    await service.skip(orgA, userA, queued[0].id);
    expect(transport.sendEmail).not.toHaveBeenCalled();

    const list = await service.list(orgA, program.id);
    expect(list[0].status).toBe('skipped');
    expect(list[1].isNext).toBe(true);
  });

  it('isolates orgs and refuses send while SMTP is off', async () => {
    const programB = createProgram(orgB);
    await expect(service.list(orgA, programB.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const program = createProgram(orgA);
    const application = createInReview(
      orgA,
      program.id,
      'Aina',
      'aina@example.com',
    );
    const queued = await service.queue(orgA, program.id, {
      applicationIds: [application.id],
    });
    transport.ensureReady.mockImplementation(() => {
      throw new NotificationsDisabledError();
    });
    await expect(
      service.send(orgA, userA, queued[0].id),
    ).rejects.toBeInstanceOf(ConflictException);
    const list = await service.list(orgA, program.id);
    expect(list[0].status).toBe('failed');
  });
});
