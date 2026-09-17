import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------
// A small, purpose-built in-memory fake of exactly the Prisma call surface
// OdcApplicationsService/OdcProgramsService use — same "real read-your-
// writes semantics, no live database" rationale as AutomationsService's own
// FakePrisma (see ../../ops-automation/automations.service.spec.ts). Shared
// between odc-applications.service.spec.ts and odc-programs.service.spec.ts
// so both exercise the exact same fake behavior.
// ---------------------------------------------------------------------

export interface FakeRecord {
  [key: string]: unknown;
}

export function normalizeJsonSentinels(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] =
      value === Prisma.JsonNull || value === Prisma.DbNull ? null : value;
  }
  return result;
}

export class FakeOdcPrisma {
  programs = new Map<string, FakeRecord>();
  fields = new Map<string, FakeRecord>();
  criteria = new Map<string, FakeRecord>();
  docTypes = new Map<string, FakeRecord>();
  applicants = new Map<string, FakeRecord>();
  applications = new Map<string, FakeRecord>();
  documents = new Map<string, FakeRecord>();
  scoreLines = new Map<string, FakeRecord>();
  historyEvents = new Map<string, FakeRecord>();
  actionItems = new Map<string, FakeRecord>();
  private seq = 0;

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private programWithRelations(
    program: FakeRecord,
    include?: { fields?: unknown; criteria?: unknown; docTypes?: unknown },
  ): FakeRecord {
    const result: FakeRecord = { ...program };
    if (include?.fields) {
      result.fields = Array.from(this.fields.values()).filter(
        (f) => f.programId === program.id,
      );
    }
    if (include?.criteria) {
      result.criteria = Array.from(this.criteria.values()).filter(
        (c) => c.programId === program.id,
      );
    }
    if (include?.docTypes) {
      result.docTypes = Array.from(this.docTypes.values()).filter(
        (d) => d.programId === program.id,
      );
    }
    return result;
  }

  private applicationWithRelations(
    application: FakeRecord,
    include?: {
      documents?: unknown;
      scoreLines?: unknown;
      events?: unknown;
      applicant?: unknown;
      program?: {
        include?: { fields?: unknown; criteria?: unknown; docTypes?: unknown };
      };
    },
  ): FakeRecord {
    const result: FakeRecord = { ...application };
    if (include?.documents) {
      result.documents = Array.from(this.documents.values()).filter(
        (d) => d.applicationId === application.id,
      );
    }
    if (include?.scoreLines) {
      result.scoreLines = Array.from(this.scoreLines.values()).filter(
        (s) => s.applicationId === application.id,
      );
    }
    if (include?.events) {
      result.events = Array.from(this.historyEvents.values())
        .filter((e) => e.applicationId === application.id)
        .sort(
          (a, b) =>
            (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime(),
        );
    }
    if (include?.applicant) {
      result.applicant =
        this.applicants.get(application.applicantId as string) ?? null;
    }
    if (include?.program) {
      const program = this.programs.get(application.programId as string);
      result.program = program
        ? this.programWithRelations(program, include.program.include)
        : null;
    }
    return result;
  }

  odcProgram = {
    create: ({
      data,
      include,
    }: {
      data: FakeRecord & {
        fields?: { create: FakeRecord[] };
        criteria?: { create: FakeRecord[] };
        docTypes?: { create: FakeRecord[] };
      };
      include?: { fields?: unknown; criteria?: unknown; docTypes?: unknown };
    }) => {
      const clash = Array.from(this.programs.values()).find(
        (p) => p.organizationId === data.organizationId && p.slug === data.slug,
      );
      if (clash) {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          {
            code: 'P2002',
            clientVersion: '7.8.0',
          },
        );
      }
      const id = this.id('program');
      const { fields, criteria, docTypes, ...rest } = data;
      const record: FakeRecord = {
        id,
        status: 'draft',
        description: null,
        opensAt: null,
        closesAt: null,
        requireDualReview: false,
        decisionThreshold: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...normalizeJsonSentinels(rest),
      };
      this.programs.set(id, record);
      for (const field of fields?.create ?? []) {
        const fieldId = this.id('field');
        this.fields.set(fieldId, {
          id: fieldId,
          programId: id,
          options: null,
          sortOrder: 0,
          required: false,
          ...normalizeJsonSentinels(field),
        });
      }
      for (const criterion of criteria?.create ?? []) {
        const criterionId = this.id('criterion');
        this.criteria.set(criterionId, {
          id: criterionId,
          programId: id,
          description: null,
          weight: 1,
          maxPoints: 5,
          required: true,
          sortOrder: 0,
          ...criterion,
        });
      }
      for (const docType of docTypes?.create ?? []) {
        const docTypeId = this.id('docType');
        this.docTypes.set(docTypeId, {
          id: docTypeId,
          programId: id,
          required: true,
          mimeAllow: ['application/pdf'],
          ...docType,
        });
      }
      return this.programWithRelations(record, include);
    },
    findFirst: ({
      where,
      include,
    }: {
      where: { id?: string; organizationId?: string };
      include?: { fields?: unknown; criteria?: unknown; docTypes?: unknown };
    }) => {
      const record = Array.from(this.programs.values()).find(
        (p) =>
          (where.id === undefined || p.id === where.id) &&
          (where.organizationId === undefined ||
            p.organizationId === where.organizationId),
      );
      return record ? this.programWithRelations(record, include) : null;
    },
    findMany: ({
      where,
      include,
    }: {
      where: { organizationId?: string };
      include?: { fields?: unknown; criteria?: unknown; docTypes?: unknown };
    }) => {
      return Array.from(this.programs.values())
        .filter(
          (p) =>
            where.organizationId === undefined ||
            p.organizationId === where.organizationId,
        )
        .map((p) => this.programWithRelations(p, include));
    },
    update: ({ where, data }: { where: { id: string }; data: FakeRecord }) => {
      const record = this.programs.get(where.id);
      if (!record) throw new Error('FakeOdcPrisma: program not found');
      Object.assign(record, normalizeJsonSentinels(data), {
        updatedAt: new Date(),
      });
      return record;
    },
  };

  odcField = {
    deleteMany: ({ where }: { where: { programId: string } }) => {
      for (const [id, field] of this.fields) {
        if (field.programId === where.programId) this.fields.delete(id);
      }
      return { count: 0 };
    },
    createMany: ({ data }: { data: FakeRecord[] }) => {
      for (const item of data) {
        const id = this.id('field');
        this.fields.set(id, {
          id,
          options: null,
          sortOrder: 0,
          required: false,
          ...item,
        });
      }
      return { count: data.length };
    },
  };

  odcCriterion = {
    deleteMany: ({ where }: { where: { programId: string } }) => {
      for (const [id, criterion] of this.criteria) {
        if (criterion.programId === where.programId) this.criteria.delete(id);
      }
      return { count: 0 };
    },
    createMany: ({ data }: { data: FakeRecord[] }) => {
      for (const item of data) {
        const id = this.id('criterion');
        this.criteria.set(id, {
          id,
          description: null,
          weight: 1,
          maxPoints: 5,
          required: true,
          sortOrder: 0,
          ...item,
        });
      }
      return { count: data.length };
    },
  };

  odcDocumentType = {
    deleteMany: ({ where }: { where: { programId: string } }) => {
      for (const [id, docType] of this.docTypes) {
        if (docType.programId === where.programId) this.docTypes.delete(id);
      }
      return { count: 0 };
    },
    createMany: ({ data }: { data: FakeRecord[] }) => {
      for (const item of data) {
        const id = this.id('docType');
        this.docTypes.set(id, {
          id,
          required: true,
          mimeAllow: ['application/pdf'],
          ...item,
        });
      }
      return { count: data.length };
    },
  };

  odcApplicant = {
    create: ({ data }: { data: FakeRecord }) => {
      const id = this.id('applicant');
      const record: FakeRecord = {
        id,
        email: null,
        phone: null,
        userId: null,
        createdAt: new Date(),
        ...data,
      };
      this.applicants.set(id, record);
      return record;
    },
    findFirst: ({
      where,
    }: {
      where: { id?: string; organizationId?: string };
    }) => {
      return (
        Array.from(this.applicants.values()).find(
          (a) =>
            (where.id === undefined || a.id === where.id) &&
            (where.organizationId === undefined ||
              a.organizationId === where.organizationId),
        ) ?? null
      );
    },
  };

  odcApplication = {
    create: ({ data }: { data: FakeRecord }) => {
      const clash = Array.from(this.applications.values()).find(
        (a) =>
          a.programId === data.programId && a.applicantId === data.applicantId,
      );
      if (clash) {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          {
            code: 'P2002',
            clientVersion: '7.8.0',
          },
        );
      }
      const id = this.id('application');
      const record: FakeRecord = {
        id,
        status: 'draft',
        answers: {},
        proposedTotal: null,
        finalTotal: null,
        summaryDraft: null,
        missing: null,
        submittedAt: null,
        decidedAt: null,
        decidedById: null,
        decisionReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...normalizeJsonSentinels(data),
      };
      this.applications.set(id, record);
      return record;
    },
    findFirst: ({
      where,
      include,
    }: {
      where: { id?: string; organizationId?: string };
      include?: Parameters<FakeOdcPrisma['applicationWithRelations']>[1];
    }) => {
      const record = Array.from(this.applications.values()).find(
        (a) =>
          (where.id === undefined || a.id === where.id) &&
          (where.organizationId === undefined ||
            a.organizationId === where.organizationId),
      );
      return record ? this.applicationWithRelations(record, include) : null;
    },
    findMany: ({
      where,
      include,
      orderBy,
    }: {
      where: { organizationId?: string; programId?: string };
      include?: Parameters<FakeOdcPrisma['applicationWithRelations']>[1];
      orderBy?: { updatedAt?: 'asc' | 'desc' };
    }) => {
      let records = Array.from(this.applications.values()).filter(
        (a) =>
          (where.organizationId === undefined ||
            a.organizationId === where.organizationId) &&
          (where.programId === undefined || a.programId === where.programId),
      );
      if (orderBy?.updatedAt === 'desc') {
        records = records.sort(
          (a, b) =>
            new Date(b.updatedAt as Date).getTime() -
            new Date(a.updatedAt as Date).getTime(),
        );
      }
      return records.map((record) =>
        this.applicationWithRelations(record, include),
      );
    },
    update: ({ where, data }: { where: { id: string }; data: FakeRecord }) => {
      const record = this.applications.get(where.id);
      if (!record) throw new Error('FakeOdcPrisma: application not found');
      Object.assign(record, normalizeJsonSentinels(data), {
        updatedAt: new Date(),
      });
      return record;
    },
  };

  odcDocument = {
    create: ({ data }: { data: FakeRecord }) => {
      const id = this.id('document');
      const record: FakeRecord = {
        id,
        storageKey: null,
        status: 'received',
        createdAt: new Date(),
        ...normalizeJsonSentinels(data),
      };
      this.documents.set(id, record);
      return record;
    },
  };

  odcScoreLine = {
    findMany: ({ where }: { where: { applicationId?: string } }) => {
      return Array.from(this.scoreLines.values()).filter(
        (s) =>
          where.applicationId === undefined ||
          s.applicationId === where.applicationId,
      );
    },
    upsert: ({
      where,
      create,
      update,
    }: {
      where: {
        applicationId_criterionId: {
          applicationId: string;
          criterionId: string;
        };
      };
      create: FakeRecord;
      update: FakeRecord;
    }) => {
      const key = where.applicationId_criterionId;
      const existing = Array.from(this.scoreLines.values()).find(
        (s) =>
          s.applicationId === key.applicationId &&
          s.criterionId === key.criterionId,
      );
      if (existing) {
        Object.assign(existing, normalizeJsonSentinels(update), {
          updatedAt: new Date(),
        });
        return existing;
      }
      const id = this.id('scoreLine');
      const record: FakeRecord = {
        id,
        proposedPoints: null,
        proposedBy: 'ai',
        finalPoints: null,
        rationale: null,
        updatedAt: new Date(),
        ...normalizeJsonSentinels(create),
      };
      this.scoreLines.set(id, record);
      return record;
    },
  };

  odcHistoryEvent = {
    create: ({ data }: { data: FakeRecord }) => {
      const id = this.id('history');
      const record: FakeRecord = {
        id,
        createdAt: new Date(),
        ...normalizeJsonSentinels(data),
      };
      this.historyEvents.set(id, record);
      return record;
    },
  };

  actionItem = {
    create: ({ data }: { data: FakeRecord }) => {
      const id = this.id('action');
      const record: FakeRecord = {
        id,
        approvalStatus: 'draft',
        executionStatus: 'not_started',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.actionItems.set(id, record);
      return record;
    },
  };

  // Supports both the array form (a batch of already-invoked fake calls,
  // each already a resolved value by the time this runs) and the callback
  // form (`async (tx) => ...`), passing itself as `tx` — this fake has no
  // real transactional isolation, only the same synchronous
  // read-your-writes semantics every other method here already has.
  $transaction = (
    arg: unknown[] | ((tx: FakeOdcPrisma) => Promise<unknown>),
  ) => {
    if (typeof arg === 'function') {
      return arg(this);
    }
    return Promise.all(arg);
  };
}
