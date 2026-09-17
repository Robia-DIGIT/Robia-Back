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

  it('open(): draft -> open, and only from draft', async () => {
    const program = await service.create(orgA, userA, createDto());
    const opened = await service.open(orgA, program.id);
    expect(opened.status).toBe('open');

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
