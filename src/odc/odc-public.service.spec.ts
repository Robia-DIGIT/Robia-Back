import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import { OdcApplicationsService } from './odc-applications.service';
import { OdcDocumentsService } from './odc-documents.service';
import { OdcPublicController } from './odc-public.controller';
import {
  OdcPublicService,
  type StartOdcApplicationResult,
} from './odc-public.service';
import { PrismaService } from '../prisma/prisma.service';
import { FakeOdcPrisma, type FakeRecord } from './test-support/fake-odc-prisma';
import type {
  NotificationTransport,
  SendEmailParams,
} from '../notifications/notification-transport';
import { NotificationsDisabledError } from '../notifications/notification-transport';
import type { OdcStorage } from './storage/odc-storage';

function baseEvents() {
  return { emit: jest.fn() };
}

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

class FakeTransport implements NotificationTransport {
  ready = true;
  sentEmails: SendEmailParams[] = [];

  ensureReady(): void {
    if (!this.ready) throw new NotificationsDisabledError();
  }

  sendEmail(params: SendEmailParams) {
    this.sentEmails.push(params);
    return Promise.resolve({ providerMessageId: 'msg-1' });
  }
}

describe('OdcPublicService', () => {
  const orgA = 'org-a';
  const orgB = 'org-b';

  let prisma: FakeOdcPrisma;
  let applications: OdcApplicationsService;
  let documents: OdcDocumentsService;
  let storage: FakeOdcStorage;
  let transport: FakeTransport;
  let service: OdcPublicService;

  beforeEach(() => {
    prisma = new FakeOdcPrisma();
    applications = new OdcApplicationsService(
      prisma as unknown as PrismaService,
      baseEvents() as never,
    );
    storage = new FakeOdcStorage();
    documents = new OdcDocumentsService(applications, storage);
    transport = new FakeTransport();
    const config = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    service = new OdcPublicService(
      prisma as unknown as PrismaService,
      applications,
      documents,
      config,
      transport,
    );
    delete process.env.ODC_PUBLIC_RETURN_TOKEN;
  });

  afterEach(() => {
    delete process.env.ODC_PUBLIC_RETURN_TOKEN;
  });

  function createProgram(
    organizationId: string,
    overrides: Partial<{
      status: string;
      fields: FakeRecord[];
      docTypes: FakeRecord[];
    }> = {},
  ) {
    return prisma.odcProgram.create({
      data: {
        organizationId,
        slug: 'programme-public',
        name: 'Programme public',
        createdById: 'staff-1',
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
        criteria: { create: [] },
        docTypes: {
          create: overrides.docTypes ?? [
            { key: 'id_card', label: "Pièce d'identité", required: true },
          ],
        },
      },
      include: { fields: true, criteria: true, docTypes: true },
    }) as FakeRecord & {
      id: string;
      publicKey: string;
      fields: FakeRecord[];
      docTypes: FakeRecord[];
    };
  }

  async function startAndReturnToken(
    publicKey: string,
    email = 'aina@candidate.mg',
    displayName = 'Aina R.',
  ): Promise<{ result: StartOdcApplicationResult; token: string }> {
    process.env.ODC_PUBLIC_RETURN_TOKEN = '1';
    const result = await service.start(publicKey, { email, displayName });
    if (!result.magicToken) {
      throw new Error('Expected a magicToken with ODC_PUBLIC_RETURN_TOKEN=1');
    }
    return { result, token: result.magicToken };
  }

  // ---------------------------------------------------------------------
  // start(): program status
  // ---------------------------------------------------------------------

  it('returns 404 for a publicKey that does not resolve to any program', async () => {
    await expect(
      service.start('does-not-exist', {
        email: 'a@b.com',
        displayName: 'A',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 409 when the program exists but is not open (e.g. draft)', async () => {
    const program = createProgram(orgA, { status: 'draft' });
    await expect(
      service.start(program.publicKey, {
        email: 'a@b.com',
        displayName: 'A',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns 404 from GET the program route for a closed program (never 409)', async () => {
    const program = createProgram(orgA, { status: 'closed' });
    await expect(service.getProgram(program.publicKey)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ---------------------------------------------------------------------
  // start(): resume, cooldown, one dossier per (program, email)
  // ---------------------------------------------------------------------

  it('reuses the same application and issues a fresh session on a second start() outside the cooldown window', async () => {
    const program = createProgram(orgA);
    const first = await startAndReturnToken(program.publicKey);

    // Simulate the 60s cooldown having elapsed, without faking real time.
    for (const session of prisma.applicantSessions.values()) {
      session.createdAt = new Date(Date.now() - 61_000);
    }

    const second = await startAndReturnToken(program.publicKey);

    expect(second.token).not.toBe(first.token);
    expect(prisma.applications.size).toBe(1);
    // The old token was invalidated by the second start() call.
    await expect(service.getApplication(first.token)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // The new one resolves to the very same application.
    const view = await service.getApplication(second.token);
    expect(prisma.applications.size).toBe(1);
    expect(view.id).toBe(
      Array.from(prisma.applications.values())[0].id as string,
    );
  });

  it('never creates a second application for the same (program, email)', async () => {
    const program = createProgram(orgA);
    await startAndReturnToken(program.publicKey);
    for (const session of prisma.applicantSessions.values()) {
      session.createdAt = new Date(Date.now() - 61_000);
    }
    await startAndReturnToken(program.publicKey);
    expect(prisma.applications.size).toBe(1);
    expect(prisma.applicants.size).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Security — cooldown, single response shape, no email enumeration
  // ---------------------------------------------------------------------

  it('does not issue a new session or resend within the 60s cooldown for the same email', async () => {
    const program = createProgram(orgA);
    await startAndReturnToken(program.publicKey);
    expect(transport.sentEmails).toHaveLength(1);

    process.env.ODC_PUBLIC_RETURN_TOKEN = '1';
    const cooldownResult = await service.start(program.publicKey, {
      email: 'aina@candidate.mg',
      displayName: 'Aina R.',
    });

    // Same generic success shape either way — never a different status or
    // an error revealing "this email already has a session". `magicToken`
    // itself can never appear on a cooldown hit (only its hash was ever
    // persisted, so there is no raw token left to return) — that is not an
    // enumeration signal since it only ever appears at all behind the
    // test-only opt-in flag, never in production.
    expect(cooldownResult).toHaveProperty('expiresAt');
    expect(cooldownResult).toHaveProperty('emailSent');
    expect(cooldownResult.emailSent).toBe(false);
    expect(transport.sentEmails).toHaveLength(1); // no second email sent
    expect(prisma.applicantSessions.size).toBe(1); // no second session row
  });

  it('never exposes magicToken unless both NODE_ENV=test and ODC_PUBLIC_RETURN_TOKEN=1', async () => {
    const program = createProgram(orgA);
    // NODE_ENV is already 'test' under Jest, but the opt-in flag is unset —
    // see beforeEach's explicit `delete`.
    const result = await service.start(program.publicKey, {
      email: 'no-token@candidate.mg',
      displayName: 'No Token',
    });
    expect(result).not.toHaveProperty('magicToken');
    expect(Object.keys(result).sort()).toEqual(['emailSent', 'expiresAt']);
  });

  it('skips SMTP entirely for an @example.com address (RC-32 convention)', async () => {
    const program = createProgram(orgA);
    const { result } = await startAndReturnToken(
      program.publicKey,
      'demo@example.com',
    );
    expect(result.emailSent).toBe(false);
    expect(transport.sentEmails).toHaveLength(0);
  });

  it('returns emailSent: false (never throws) when the notification transport is unavailable', async () => {
    transport.ready = false;
    const program = createProgram(orgA);
    const { result } = await startAndReturnToken(program.publicKey);
    expect(result.emailSent).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Token resolution — always 404, never 403, including timing-safe compare
  // ---------------------------------------------------------------------

  it('returns 404 for an unknown token', async () => {
    await expect(
      service.getApplication('unknown-token'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 for a token of the same length as a real one but different content (exercises the timingSafeEqual path)', async () => {
    const program = createProgram(orgA);
    const { token } = await startAndReturnToken(program.publicKey);
    expect(token).toHaveLength(64); // 32 random bytes, hex-encoded

    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    await expect(service.getApplication(tampered)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns 404 for an expired token', async () => {
    const program = createProgram(orgA);
    const { token } = await startAndReturnToken(program.publicKey);
    for (const session of prisma.applicantSessions.values()) {
      session.expiresAt = new Date(Date.now() - 1000);
    }
    await expect(service.getApplication(token)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("never resolves org A's token into org B's application data (dossier isolation)", async () => {
    const programA = createProgram(orgA);
    const programB = createProgram(orgB);
    const { token: tokenA } = await startAndReturnToken(
      programA.publicKey,
      'candidate-a@mail.mg',
    );
    await startAndReturnToken(programB.publicKey, 'candidate-b@mail.mg');

    const viewA = await service.getApplication(tokenA);
    const applicationA = Array.from(prisma.applications.values()).find(
      (a) => a.organizationId === orgA,
    );
    expect(viewA.id).toBe(applicationA?.id);
    // Nothing about org B ever leaks through org A's own token.
    const applicationB = Array.from(prisma.applications.values()).find(
      (a) => a.organizationId === orgB,
    );
    expect(viewA.id).not.toBe(applicationB?.id);
  });

  // ---------------------------------------------------------------------
  // Public DTO shape — never storageKey/decisionReason/scores/organizationId
  // ---------------------------------------------------------------------

  it('never includes storageKey, decisionReason, scores or organizationId in the public application view', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const { token } = await startAndReturnToken(program.publicKey);
    await service.submit(token);

    const view = (await service.getApplication(token)) as unknown as Record<
      string,
      unknown
    >;
    for (const forbidden of [
      'organizationId',
      'applicantId',
      'decisionReason',
      'decidedAt',
      'decidedById',
      'proposedTotal',
      'finalTotal',
      'scoreLines',
      'storageKey',
    ]) {
      expect(view).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(view)).not.toContain('storageKey');
  });

  // ---------------------------------------------------------------------
  // submit(): real completeness screening, no forced status
  // ---------------------------------------------------------------------

  it('moves to "incomplete" (never a forced status) when required fields/documents are missing', async () => {
    const program = createProgram(orgA); // requires field + document
    const { token } = await startAndReturnToken(program.publicKey);
    const view = await service.submit(token);
    expect(view.status).toBe('incomplete');
    expect(view.missing).toContain('field:motivation');
    expect(view.missing).toContain('document:id_card');
  });

  it('moves to "in_review" via real screening once the dossier is actually complete', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const { token } = await startAndReturnToken(program.publicKey);
    const view = await service.submit(token);
    expect(view.status).toBe('in_review');
    expect(view.missing).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Write lock once past draft/incomplete
  // ---------------------------------------------------------------------

  it('refuses to edit answers once the dossier is in_review (409, not silently ignored)', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const { token } = await startAndReturnToken(program.publicKey);
    await service.submit(token); // -> in_review (complete dossier)

    await expect(
      service.updateAnswers(token, { answers: { motivation: 'late edit' } }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a document upload once the dossier is in_review', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const { token } = await startAndReturnToken(program.publicKey);
    await service.submit(token);

    await expect(
      service.upload(
        token,
        (program.docTypes[0]?.id as string | undefined) ?? 'doc-type-1',
        {
          buffer: Buffer.from('data'),
          mimetype: 'application/pdf',
          originalname: 'cv.pdf',
          size: 4,
        },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows withdraw() even from in_review — it is not gated like answers/uploads are', async () => {
    const program = createProgram(orgA, { fields: [], docTypes: [] });
    const { token } = await startAndReturnToken(program.publicKey);
    await service.submit(token);

    const view = await service.withdraw(token, { reason: 'Changed my mind' });
    expect(view.status).toBe('withdrawn');
  });

  // ---------------------------------------------------------------------
  // Upload: MIME rejection never leaves an orphan file
  // ---------------------------------------------------------------------

  it('rejects a disallowed MIME type and leaves zero files on disk', async () => {
    const program = createProgram(orgA, {
      fields: [],
      docTypes: [
        {
          key: 'id_card',
          label: "Pièce d'identité",
          required: true,
          mimeAllow: ['application/pdf'],
        },
      ],
    });
    const { token } = await startAndReturnToken(program.publicKey);
    const docTypeId = program.docTypes[0].id as string;

    await expect(
      service.upload(token, docTypeId, {
        buffer: Buffer.from('not a pdf'),
        mimetype: 'image/gif',
        originalname: 'malware.gif',
        size: 9,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.fileCount()).toBe(0);
  });

  // ---------------------------------------------------------------------
  // No decide()/scores/outreach/listByProgram/open/close reachable here
  // ---------------------------------------------------------------------

  it('has no method and no route that can reach decide(), scores, outreach or program administration', () => {
    const servicePrototype = OdcPublicService.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const forbidden of [
      'decide',
      'proposeScores',
      'updateFinalScores',
      'proposeSummary',
      'listByProgram',
      'queueOutreach',
      'openProgram',
      'closeProgram',
      'createProgram',
    ]) {
      expect(servicePrototype[forbidden]).toBeUndefined();
    }

    const controllerPrototype =
      OdcPublicController.prototype as unknown as Record<string, unknown>;
    for (const forbidden of [
      'decide',
      'proposeScores',
      'updateScores',
      'proposeSummary',
      'listApplications',
      'queueOutreach',
      'sendOutreach',
      'openProgram',
      'closeProgram',
      'createProgram',
    ]) {
      expect(controllerPrototype[forbidden]).toBeUndefined();
    }
  });
});
