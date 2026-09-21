import { ConflictException, NotFoundException } from '@nestjs/common';
import { OdcProgramsService } from './odc-programs.service';
import { PrismaService } from '../prisma/prisma.service';
import { FakeOdcPrisma } from './test-support/fake-odc-prisma';

describe('OdcProgramsService', () => {
  const orgA = 'org-a';
  const orgB = 'org-b';
  const userA = 'user-a';

  let prisma: FakeOdcPrisma;
  let service: OdcProgramsService;

  beforeEach(() => {
    prisma = new FakeOdcPrisma();
    service = new OdcProgramsService(prisma as unknown as PrismaService);
  });

  function createDto(
    overrides: Partial<Parameters<OdcProgramsService['create']>[2]> = {},
  ) {
    return {
      slug: 'programme-1',
      name: 'Programme 1',
      fields: [
        {
          key: 'motivation',
          label: 'Motivation',
          required: true,
          fieldType: 'longtext' as const,
        },
      ],
      criteria: [{ key: 'c1', label: 'Critère 1' }],
      docTypes: [{ key: 'id_card', label: "Pièce d'identité" }],
      ...overrides,
    };
  }

  it('creates a program with its fields/criteria/docTypes, starting in draft', async () => {
    const program = await service.create(orgA, userA, createDto());
    expect(program.status).toBe('draft');
    expect(program.fields).toHaveLength(1);
    expect(program.criteria).toHaveLength(1);
    expect(program.docTypes).toHaveLength(1);
  });

  it('rejects a duplicate slug within the same organization', async () => {
    await service.create(orgA, userA, createDto());
    await expect(
      service.create(orgA, userA, createDto()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows the same slug across two different organizations', async () => {
    await service.create(orgA, userA, createDto());
    await expect(
      service.create(orgB, userA, createDto()),
    ).resolves.toBeDefined();
  });

  it("never lets one organization read another organization's program", async () => {
    const program = await service.create(orgA, userA, createDto());
    await expect(service.findOne(orgB, program.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('open(): draft -> open, closed -> open, not from open or archived', async () => {
    const program = await service.create(orgA, userA, createDto());
    const opened = await service.open(orgA, program.id);
    expect(opened.status).toBe('open');

    await expect(service.open(orgA, program.id)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const closed = await service.close(orgA, program.id);
    expect(closed.status).toBe('closed');
    const reopened = await service.open(orgA, program.id);
    expect(reopened.status).toBe('open');

    await prisma.odcProgram.update({
      where: { id: program.id },
      data: { status: 'archived' },
    });
    await expect(service.open(orgA, program.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('close(): open -> closed, and only from open', async () => {
    const program = await service.create(orgA, userA, createDto());
    await expect(service.close(orgA, program.id)).rejects.toBeInstanceOf(
      ConflictException,
    );

    await service.open(orgA, program.id);
    const closed = await service.close(orgA, program.id);
    expect(closed.status).toBe('closed');
  });

  it('update() edits top-level fields without touching an omitted definition array', async () => {
    const program = await service.create(orgA, userA, createDto());
    const updated = await service.update(orgA, program.id, {
      name: 'Nouveau nom',
    });
    expect(updated.name).toBe('Nouveau nom');
    expect(updated.fields).toHaveLength(1);
  });

  it('update() wholesale-replaces a definition array when it is provided', async () => {
    const program = await service.create(orgA, userA, createDto());
    const updated = await service.update(orgA, program.id, {
      fields: [{ key: 'new_field', label: 'Nouveau champ', fieldType: 'text' }],
    });
    expect(updated.fields).toHaveLength(1);
    expect(updated.fields[0].key).toBe('new_field');
  });

  // ---------------------------------------------------------------------
  // Program definition protection (RC-33 hardening)
  // ---------------------------------------------------------------------

  function createApplicationFor(programId: string): { id: string } {
    const applicant = prisma.odcApplicant.create({
      data: { organizationId: orgA, displayName: 'Jane Doe' },
    }) as { id: string };
    return prisma.odcApplication.create({
      data: { organizationId: orgA, programId, applicantId: applicant.id },
    }) as { id: string };
  }

  it('update() still wholesale-replaces criteria/docTypes while no candidature exists yet', async () => {
    const program = await service.create(orgA, userA, createDto());
    const updated = await service.update(orgA, program.id, {
      criteria: [{ key: 'new_criterion', label: 'Nouveau critère' }],
      docTypes: [{ key: 'new_doc', label: 'Nouveau document' }],
    });
    expect(updated.criteria).toHaveLength(1);
    expect(updated.criteria[0].key).toBe('new_criterion');
    expect(updated.docTypes).toHaveLength(1);
    expect(updated.docTypes[0].key).toBe('new_doc');
  });

  it('update() refuses to modify criteria once the program has at least one candidature', async () => {
    const program = await service.create(orgA, userA, createDto());
    createApplicationFor(program.id);

    await expect(
      service.update(orgA, program.id, {
        criteria: [{ key: 'new_criterion', label: 'Nouveau critère' }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // Never wholesale-replaced — the original criterion must still be there.
    const unchanged = await service.findOne(orgA, program.id);
    expect(unchanged.criteria[0].key).toBe('c1');
  });

  it('update() refuses to modify docTypes once the program has at least one candidature', async () => {
    const program = await service.create(orgA, userA, createDto());
    createApplicationFor(program.id);

    await expect(
      service.update(orgA, program.id, {
        docTypes: [{ key: 'new_doc', label: 'Nouveau document' }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const unchanged = await service.findOne(orgA, program.id);
    expect(unchanged.docTypes[0].key).toBe('id_card');
  });

  it('update() still allows editing top-level fields (e.g. name) once the program has at least one candidature', async () => {
    const program = await service.create(orgA, userA, createDto());
    createApplicationFor(program.id);

    const updated = await service.update(orgA, program.id, {
      name: 'Nouveau nom',
    });
    expect(updated.name).toBe('Nouveau nom');
  });

  it('update() still allows editing fields (unprotected) once the program has at least one candidature', async () => {
    const program = await service.create(orgA, userA, createDto());
    createApplicationFor(program.id);

    const updated = await service.update(orgA, program.id, {
      fields: [{ key: 'new_field', label: 'Nouveau champ', fieldType: 'text' }],
    });
    expect(updated.fields[0].key).toBe('new_field');
  });

  // Integration scenario #7 from the PR2 spec: a program with a real
  // document and a real scoreLine already referencing its criteria/docTypes
  // — not just a bare application row — is exactly the case the FK
  // (@@unique + Restrict-by-default relations) would otherwise blow up on
  // with a raw, unhandled constraint error if criteria/docTypes were ever
  // deleteMany()'d out from under them.
  it('update() refuses criteria/docTypes changes when the program has real documents and scoreLines attached', async () => {
    const program = await service.create(orgA, userA, createDto());
    const application = createApplicationFor(program.id);
    prisma.odcDocument.create({
      data: {
        organizationId: orgA,
        applicationId: application.id,
        documentTypeId: program.docTypes[0].id,
        originalName: 'cv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        storageKey: `${orgA}/${application.id}/doc-1/uuid.pdf`,
        status: 'received',
      },
    });
    prisma.odcScoreLine.upsert({
      where: {
        applicationId_criterionId: {
          applicationId: application.id,
          criterionId: program.criteria[0].id,
        },
      },
      create: {
        organizationId: orgA,
        applicationId: application.id,
        criterionId: program.criteria[0].id,
        proposedPoints: 3,
      },
      update: {},
    });

    await expect(
      service.update(orgA, program.id, {
        criteria: [{ key: 'new_criterion', label: 'Nouveau critère' }],
        docTypes: [{ key: 'new_doc', label: 'Nouveau document' }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // The document and scoreLine still resolve to the original,
    // untouched criterion/docType ids — never dangling.
    const unchanged = await service.findOne(orgA, program.id);
    expect(unchanged.criteria[0].id).toBe(program.criteria[0].id);
    expect(unchanged.docTypes[0].id).toBe(program.docTypes[0].id);
  });

  it('rejects editing an archived program', async () => {
    const program = await service.create(orgA, userA, createDto());
    // No route reaches 'archived' in this RC — simulate it directly to
    // exercise the guard, per docs/RC29_ODC_CANDIDATURES.md's own residual
    // risk note.
    prisma.odcProgram.update({
      where: { id: program.id },
      data: { status: 'archived' },
    });

    await expect(
      service.update(orgA, program.id, { name: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('findOne() 404s across organizations', async () => {
    const program = await service.create(orgA, userA, createDto());
    await expect(service.findOne(orgB, program.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
