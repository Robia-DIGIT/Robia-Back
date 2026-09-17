import { ConflictException } from '@nestjs/common';
import { OdcProgramsService } from '../odc-programs.service';
import { OdcApplicationsService } from '../odc-applications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FakeOdcPrisma } from '../test-support/fake-odc-prisma';
import {
  ODC_DEMO_APPLICANTS,
  ODC_DEMO_PROGRAM_SLUG,
  seedOdcDemo,
} from './odc-demo-seed';

function baseEvents() {
  return { emit: jest.fn() };
}

describe('seedOdcDemo', () => {
  const orgA = 'org-a';
  const userA = 'user-a';

  let prisma: FakeOdcPrisma;
  let programs: OdcProgramsService;
  let applications: OdcApplicationsService;

  beforeEach(() => {
    prisma = new FakeOdcPrisma();
    programs = new OdcProgramsService(prisma as unknown as PrismaService);
    applications = new OdcApplicationsService(
      prisma as unknown as PrismaService,
      baseEvents() as never,
    );
  });

  it('creates one open program and every demo applicant reaches in_review', async () => {
    const result = await seedOdcDemo({ programs, applications }, orgA, userA);

    expect(result.applications).toHaveLength(ODC_DEMO_APPLICANTS.length);
    for (const application of result.applications) {
      expect(application.status).toBe('in_review');
      expect(application.missing).toBeNull();
    }

    const [program] = await programs.findAll(orgA);
    expect(program.slug).toBe(ODC_DEMO_PROGRAM_SLUG);
    expect(program.status).toBe('open');
  });

  it('gives every demo applicant a real email and the two required documents, both received', async () => {
    const result = await seedOdcDemo({ programs, applications }, orgA, userA);

    for (const application of result.applications) {
      expect(application.applicant.email).toMatch(/^[^@]+@example\.com$/);
      expect(application.documents).toHaveLength(2);
      for (const document of application.documents) {
        expect(document.status).toBe('received');
      }
      const documentTypeKeys = application.documents
        .map(
          (doc) =>
            application.program.docTypes.find(
              (dt) => dt.id === doc.documentTypeId,
            )?.key,
        )
        .sort();
      expect(documentTypeKeys).toEqual(['cv', 'pitch_deck']);
    }
  });

  // Locks in the property the seed's own doc comment relies on: every demo
  // recipient is under example.com (RFC 2606, never a real inbox), so an
  // operator who forgets this is demo data and queues/sends an outreach
  // email against it can never actually deliver anything.
  it('never uses a real-looking email domain for a demo applicant', () => {
    for (const applicant of ODC_DEMO_APPLICANTS) {
      expect(applicant.email.endsWith('@example.com')).toBe(true);
    }
  });

  it('never writes a decidable/terminal status — only in_review, never accepted/rejected/waitlisted', async () => {
    const result = await seedOdcDemo({ programs, applications }, orgA, userA);
    for (const application of result.applications) {
      expect(['accepted', 'rejected', 'waitlisted']).not.toContain(
        application.status,
      );
    }
  });

  it('is not idempotent: a second call for the same organization is rejected', async () => {
    await seedOdcDemo({ programs, applications }, orgA, userA);
    await expect(
      seedOdcDemo({ programs, applications }, orgA, userA),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not affect another organization', async () => {
    await seedOdcDemo({ programs, applications }, orgA, userA);
    const result = await seedOdcDemo(
      { programs, applications },
      'org-b',
      userA,
    );
    expect(result.applications).toHaveLength(ODC_DEMO_APPLICANTS.length);
    expect(await programs.findAll('org-b')).toHaveLength(1);
    expect(await programs.findAll(orgA)).toHaveLength(1);
  });
});
