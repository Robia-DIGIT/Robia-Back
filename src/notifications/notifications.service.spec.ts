import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationAuditResolutionError,
  NotificationAutomationContextError,
  NotificationRetryNotAllowedError,
  NotificationsService,
} from './notifications.service';
import { InvalidNotificationTemplateDataError } from './notification-templates';

interface FakeRecord {
  [key: string]: unknown;
}

// Purpose-built, scoped to exactly the Prisma calls NotificationsService
// makes: automation.findUnique() + organization.findUnique() (context
// resolution), audit.findFirst() (audit_completed's own data resolution —
// see resolveTemplateData()), and notificationDelivery.create/findUnique/
// findMany/findFirst/update/updateMany() — mirrors the same synchronous
// find-then-mutate shape, and the same P2002-on-unique-conflict
// simulation, as automations.service.spec.ts's own FakePrisma.
class FakePrisma {
  automations = new Map<string, FakeRecord>();
  organizations = new Map<string, FakeRecord>();
  audits = new Map<string, FakeRecord>();
  deliveries = new Map<string, FakeRecord>();
  private seq = 0;

  private id(prefix: string) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  automation = {
    findUnique: ({ where }: { where: { id: string } }) => {
      const record = this.automations.get(where.id);
      if (!record) return null;
      return { ...record, createdBy: record.createdBy };
    },
  };

  organization = {
    findUnique: ({ where }: { where: { id: string } }) => {
      const record = this.organizations.get(where.id);
      return record ? { ...record } : null;
    },
  };

  audit = {
    findFirst: ({
      where,
    }: {
      where: { id: string; organizationId: string };
    }) => {
      const record = this.audits.get(where.id);
      if (!record || record.organizationId !== where.organizationId) {
        return null;
      }
      return { ...record, website: record.website };
    },
  };

  notificationDelivery = {
    create: ({ data }: { data: Record<string, unknown> }) => {
      const conflict = Array.from(this.deliveries.values()).find(
        (d) =>
          d.organizationId === data.organizationId &&
          d.idempotencyKey === data.idempotencyKey,
      );
      if (conflict) {
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed',
          { code: 'P2002', clientVersion: '7.8.0' },
        );
      }
      const id = this.id('delivery');
      const record: FakeRecord = {
        id,
        channel: 'email',
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: new Date(),
        claimedAt: null,
        providerMessageId: null,
        lastError: null,
        sentAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.deliveries.set(id, record);
      return { ...record };
    },
    findUnique: ({
      where,
    }: {
      where: {
        id?: string;
        organizationId_idempotencyKey?: {
          organizationId: string;
          idempotencyKey: string;
        };
      };
    }) => {
      if (where.id) {
        const record = this.deliveries.get(where.id);
        return record ? { ...record } : null;
      }
      const key = where.organizationId_idempotencyKey!;
      const record = Array.from(this.deliveries.values()).find(
        (d) =>
          d.organizationId === key.organizationId &&
          d.idempotencyKey === key.idempotencyKey,
      );
      return record ? { ...record } : null;
    },
    findFirst: ({
      where,
    }: {
      where: { id: string; organizationId: string };
    }) => {
      const record = this.deliveries.get(where.id);
      if (!record || record.organizationId !== where.organizationId) {
        return null;
      }
      return { ...record, recipient: record.recipient };
    },
    findMany: ({ where }: { where: { organizationId: string } }) => {
      return Array.from(this.deliveries.values())
        .filter((d) => d.organizationId === where.organizationId)
        .map((d) => ({ ...d, recipient: d.recipient }));
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const record = this.deliveries.get(where.id);
      if (!record) throw new Error('FakePrisma: delivery not found');
      Object.assign(record, data, { updatedAt: new Date() });
      return { ...record };
    },
    updateMany: ({
      where,
      data,
    }: {
      where: { id: string; organizationId: string; status: { in: string[] } };
      data: Record<string, unknown>;
    }) => {
      const record = this.deliveries.get(where.id);
      if (
        !record ||
        record.organizationId !== where.organizationId ||
        !where.status.in.includes(record.status as string)
      ) {
        return { count: 0 };
      }
      Object.assign(record, data, { updatedAt: new Date() });
      return { count: 1 };
    },
  };
}

function seedAutomation(
  prisma: FakePrisma,
  overrides: Partial<FakeRecord> = {},
) {
  const automation: FakeRecord = {
    id: 'automation-1',
    organizationId: 'org-1',
    createdById: 'user-1',
    createdBy: { id: 'user-1', email: 'jane@example.com' },
    ...overrides,
  };
  prisma.automations.set(automation.id as string, automation);
  prisma.organizations.set('org-1', { id: 'org-1', ownerId: 'user-1' });
  return automation;
}

function seedAudit(prisma: FakePrisma, overrides: Partial<FakeRecord> = {}) {
  const audit: FakeRecord = {
    id: 'audit-1',
    organizationId: 'org-1',
    globalScore: 82,
    website: { url: 'https://example.com' },
    ...overrides,
  };
  prisma.audits.set(audit.id as string, audit);
  return audit;
}

describe('NotificationsService', () => {
  let prisma: FakePrisma;
  let service: NotificationsService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new NotificationsService(prisma as unknown as PrismaService);
  });

  describe('createEmailDelivery', () => {
    it('creates a pending delivery addressed to Automation.createdBy, never a caller-supplied recipient', async () => {
      seedAutomation(prisma);
      const { delivery, recipientEmail } = await service.createEmailDelivery({
        organizationId: 'org-1',
        automationId: 'automation-1',
        automationRunId: 'run-1',
        automationStepRunId: 'step-1',
        templateKey: 'automation_failed',
        templateData: {
          automationName: 'Test automation',
          errorMessage: 'Timeout',
        },
      });
      expect(recipientEmail).toBe('jane@example.com');
      expect(delivery).toMatchObject({
        organizationId: 'org-1',
        recipientUserId: 'user-1',
        channel: 'email',
        templateKey: 'automation_failed',
        status: 'pending',
        idempotencyKey: 'automation-step:step-1',
      });
    });

    it('rejects invalid template data before persisting anything', async () => {
      seedAutomation(prisma);
      await expect(
        service.createEmailDelivery({
          organizationId: 'org-1',
          automationId: 'automation-1',
          automationRunId: 'run-1',
          automationStepRunId: 'step-1',
          templateKey: 'automation_failed',
          templateData: { unexpected: 'value' },
        }),
      ).rejects.toBeInstanceOf(InvalidNotificationTemplateDataError);
      expect(prisma.deliveries.size).toBe(0);
    });

    it('rejects when the automation does not belong to the given organization', async () => {
      seedAutomation(prisma, { organizationId: 'org-other' });
      await expect(
        service.createEmailDelivery({
          organizationId: 'org-1',
          automationId: 'automation-1',
          automationRunId: 'run-1',
          automationStepRunId: 'step-1',
          templateKey: 'automation_failed',
          templateData: {
            automationName: 'Test automation',
            errorMessage: 'Timeout',
          },
        }),
      ).rejects.toBeInstanceOf(NotificationAutomationContextError);
    });

    it("rejects when the automation's creator does not own the given organization", async () => {
      seedAutomation(prisma);
      prisma.organizations.set('org-1', {
        id: 'org-1',
        ownerId: 'someone-else',
      });
      await expect(
        service.createEmailDelivery({
          organizationId: 'org-1',
          automationId: 'automation-1',
          automationRunId: 'run-1',
          automationStepRunId: 'step-1',
          templateKey: 'automation_failed',
          templateData: {
            automationName: 'Test automation',
            errorMessage: 'Timeout',
          },
        }),
      ).rejects.toBeInstanceOf(NotificationAutomationContextError);
    });

    it('is idempotent: a repeat call for the same automation run + step returns the exact same delivery, never a second one', async () => {
      seedAutomation(prisma);
      const params = {
        organizationId: 'org-1',
        automationId: 'automation-1',
        automationRunId: 'run-1',
        automationStepRunId: 'step-1',
        templateKey: 'automation_failed',
        templateData: {
          automationName: 'Test automation',
          errorMessage: 'Timeout',
        },
      };
      const first = await service.createEmailDelivery(params);
      const second = await service.createEmailDelivery(params);
      expect(second.delivery.id).toBe(first.delivery.id);
      expect(prisma.deliveries.size).toBe(1);
    });
  });

  // RC-26 review fix: the real audit.completed event only ever carries
  // auditId/websiteId/globalScore (never a websiteUrl string — see
  // audit-completed.event.ts) — audit_completed's templateData is
  // therefore always resolved fresh from the real Audit record, org-scoped,
  // never trusted verbatim from the caller.
  describe('audit_completed resolution', () => {
    it('resolves websiteUrl and a formatted score from the real Audit record, ignoring any caller-supplied templateData', async () => {
      seedAutomation(prisma);
      seedAudit(prisma, {
        globalScore: 91,
        website: { url: 'https://robiacopilot.site' },
      });

      const { delivery } = await service.createEmailDelivery({
        organizationId: 'org-1',
        automationId: 'automation-1',
        automationRunId: 'run-1',
        automationStepRunId: 'step-1',
        templateKey: 'audit_completed',
        auditId: 'audit-1',
        // Deliberately different from the real audit, to prove it's
        // ignored rather than trusted.
        templateData: {
          websiteUrl: 'https://attacker.example',
          scoreLine: '0/100',
        },
      });

      expect(delivery.templateData).toEqual({
        websiteUrl: 'https://robiacopilot.site',
        scoreLine: '91/100',
      });
    });

    it('formats an absent score explicitly, never "null/100"', async () => {
      seedAutomation(prisma);
      seedAudit(prisma, { globalScore: null });

      const { delivery } = await service.createEmailDelivery({
        organizationId: 'org-1',
        automationId: 'automation-1',
        automationRunId: 'run-1',
        automationStepRunId: 'step-1',
        templateKey: 'audit_completed',
        auditId: 'audit-1',
      });

      expect(delivery.templateData).toMatchObject({
        scoreLine: 'non disponible',
      });
    });

    it('rejects audit_completed when auditId is missing', async () => {
      seedAutomation(prisma);
      await expect(
        service.createEmailDelivery({
          organizationId: 'org-1',
          automationId: 'automation-1',
          automationRunId: 'run-1',
          automationStepRunId: 'step-1',
          templateKey: 'audit_completed',
        }),
      ).rejects.toBeInstanceOf(NotificationAuditResolutionError);
      expect(prisma.deliveries.size).toBe(0);
    });

    it('rejects audit_completed when the audit belongs to a different organization', async () => {
      seedAutomation(prisma);
      seedAudit(prisma, { organizationId: 'org-other' });
      await expect(
        service.createEmailDelivery({
          organizationId: 'org-1',
          automationId: 'automation-1',
          automationRunId: 'run-1',
          automationStepRunId: 'step-1',
          templateKey: 'audit_completed',
          auditId: 'audit-1',
        }),
      ).rejects.toBeInstanceOf(NotificationAuditResolutionError);
      expect(prisma.deliveries.size).toBe(0);
    });

    it('rejects audit_completed when the audit does not exist', async () => {
      seedAutomation(prisma);
      await expect(
        service.createEmailDelivery({
          organizationId: 'org-1',
          automationId: 'automation-1',
          automationRunId: 'run-1',
          automationStepRunId: 'step-1',
          templateKey: 'audit_completed',
          auditId: 'does-not-exist',
        }),
      ).rejects.toBeInstanceOf(NotificationAuditResolutionError);
    });
  });

  describe('findAllForOrganization / findOne', () => {
    it('never returns a delivery belonging to a different organization', async () => {
      seedAutomation(prisma);
      const { delivery } = await service.createEmailDelivery({
        organizationId: 'org-1',
        automationId: 'automation-1',
        automationRunId: 'run-1',
        automationStepRunId: 'step-1',
        templateKey: 'automation_failed',
        templateData: {
          automationName: 'Test automation',
          errorMessage: 'Timeout',
        },
      });

      await expect(service.findOne('org-other', delivery.id)).rejects.toThrow();
      const list = await service.findAllForOrganization('org-other');
      expect(list).toHaveLength(0);
    });
  });

  describe('retry', () => {
    it('puts a dead_letter delivery back to pending, preserving its idempotencyKey, without creating a new row', async () => {
      seedAutomation(prisma);
      const { delivery } = await service.createEmailDelivery({
        organizationId: 'org-1',
        automationId: 'automation-1',
        automationRunId: 'run-1',
        automationStepRunId: 'step-1',
        templateKey: 'automation_failed',
        templateData: {
          automationName: 'Test automation',
          errorMessage: 'Timeout',
        },
      });
      prisma.deliveries.get(delivery.id)!.status = 'dead_letter';

      const retried = await service.retry('org-1', delivery.id);
      expect(retried.status).toBe('pending');
      expect(retried.claimedAt).toBeNull();
      expect(retried.idempotencyKey).toBe(delivery.idempotencyKey);
      expect(prisma.deliveries.size).toBe(1);
    });

    it('rejects retrying a delivery that is not dead_letter', async () => {
      seedAutomation(prisma);
      const { delivery } = await service.createEmailDelivery({
        organizationId: 'org-1',
        automationId: 'automation-1',
        automationRunId: 'run-1',
        automationStepRunId: 'step-1',
        templateKey: 'automation_failed',
        templateData: {
          automationName: 'Test automation',
          errorMessage: 'Timeout',
        },
      });
      await expect(service.retry('org-1', delivery.id)).rejects.toBeInstanceOf(
        NotificationRetryNotAllowedError,
      );
    });

    it('rejects retrying a delivery from a different organization', async () => {
      seedAutomation(prisma);
      const { delivery } = await service.createEmailDelivery({
        organizationId: 'org-1',
        automationId: 'automation-1',
        automationRunId: 'run-1',
        automationStepRunId: 'step-1',
        templateKey: 'automation_failed',
        templateData: {
          automationName: 'Test automation',
          errorMessage: 'Timeout',
        },
      });
      prisma.deliveries.get(delivery.id)!.status = 'dead_letter';

      await expect(service.retry('org-other', delivery.id)).rejects.toThrow();
    });

    // RC-26 review fix: retry() must use a single atomic conditional
    // update, never a read-then-write — otherwise a delivery already
    // reclaimed by a dispatcher worker (status no longer dead_letter by
    // the time the write actually happens) could have its claim silently
    // clobbered back to pending.
    it('never overwrites a delivery whose status changed between the read and the write (atomic conditional update)', async () => {
      seedAutomation(prisma);
      const { delivery } = await service.createEmailDelivery({
        organizationId: 'org-1',
        automationId: 'automation-1',
        automationRunId: 'run-1',
        automationStepRunId: 'step-1',
        templateKey: 'automation_failed',
        templateData: {
          automationName: 'Test automation',
          errorMessage: 'Timeout',
        },
      });
      prisma.deliveries.get(delivery.id)!.status = 'dead_letter';

      // Simulate a dispatcher worker reclaiming the delivery (status ->
      // processing, a fresh claimedAt) in the gap between retry()'s own
      // read (findOne, inside the 404/status pre-check) and its
      // conditional write.
      const originalFindFirst = prisma.notificationDelivery.findFirst;
      let findFirstCalls = 0;
      prisma.notificationDelivery.findFirst = (
        args: Parameters<typeof originalFindFirst>[0],
      ) => {
        findFirstCalls += 1;
        const result = originalFindFirst(args);
        if (findFirstCalls === 1) {
          const record = prisma.deliveries.get(delivery.id)!;
          record.status = 'processing';
          record.claimedAt = new Date('2026-09-21T06:05:00.000Z');
        }
        return result;
      };

      await expect(service.retry('org-1', delivery.id)).rejects.toBeInstanceOf(
        NotificationRetryNotAllowedError,
      );
      // The worker's claim must survive untouched.
      const stored = prisma.deliveries.get(delivery.id)!;
      expect(stored.status).toBe('processing');
      expect(stored.claimedAt).toEqual(new Date('2026-09-21T06:05:00.000Z'));
    });
  });
});
