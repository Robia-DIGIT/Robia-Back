import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
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
// resolution) and notificationDelivery.create/findUnique/findMany/
// findFirst/update() — mirrors the same synchronous find-then-mutate shape,
// and the same P2002-on-unique-conflict simulation, as
// automations.service.spec.ts's own FakePrisma.
class FakePrisma {
  automations = new Map<string, FakeRecord>();
  organizations = new Map<string, FakeRecord>();
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
        templateKey: 'audit_completed',
        templateData: { websiteUrl: 'https://example.com', globalScore: 80 },
      });
      expect(recipientEmail).toBe('jane@example.com');
      expect(delivery).toMatchObject({
        organizationId: 'org-1',
        recipientUserId: 'user-1',
        channel: 'email',
        templateKey: 'audit_completed',
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
          templateKey: 'audit_completed',
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
          templateKey: 'audit_completed',
          templateData: { websiteUrl: 'https://example.com', globalScore: 80 },
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
          templateKey: 'audit_completed',
          templateData: { websiteUrl: 'https://example.com', globalScore: 80 },
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
        templateKey: 'audit_completed',
        templateData: { websiteUrl: 'https://example.com', globalScore: 80 },
      };
      const first = await service.createEmailDelivery(params);
      const second = await service.createEmailDelivery(params);
      expect(second.delivery.id).toBe(first.delivery.id);
      expect(prisma.deliveries.size).toBe(1);
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
        templateKey: 'audit_completed',
        templateData: { websiteUrl: 'https://example.com', globalScore: 80 },
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
        templateKey: 'audit_completed',
        templateData: { websiteUrl: 'https://example.com', globalScore: 80 },
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
        templateKey: 'audit_completed',
        templateData: { websiteUrl: 'https://example.com', globalScore: 80 },
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
        templateKey: 'audit_completed',
        templateData: { websiteUrl: 'https://example.com', globalScore: 80 },
      });
      prisma.deliveries.get(delivery.id)!.status = 'dead_letter';

      await expect(service.retry('org-other', delivery.id)).rejects.toThrow();
    });
  });
});
