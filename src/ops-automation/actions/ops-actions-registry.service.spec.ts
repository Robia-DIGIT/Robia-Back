import { PrismaService } from '../../prisma/prisma.service';
import { AuditsService } from '../../audits/audits.service';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { OdcApplicationsService } from '../../odc/odc-applications.service';
import {
  InvalidOpsActionInputError,
  OpsActionsRegistryService,
  UnknownOpsActionError,
} from './ops-actions-registry.service';

interface MockPrisma {
  website: { count: jest.Mock };
  audit: { findFirst: jest.Mock };
  opportunity: { count: jest.Mock };
  actionItem: { count: jest.Mock; create: jest.Mock };
}
interface MockAudits {
  run: jest.Mock;
}
interface MockOpportunities {
  generateFromAudit: jest.Mock;
}
interface MockNotifications {
  createEmailDelivery: jest.Mock;
}
interface MockOdcApplications {
  prepareApplicationSummary: jest.Mock;
  recomputeMissingDocuments: jest.Mock;
  createReviewTask: jest.Mock;
}

describe('OpsActionsRegistryService', () => {
  const organizationId = 'org-1';
  const executionContext = {
    automationId: 'automation-1',
    runId: 'run-1',
    stepRunId: 'step-run-1',
  };
  let prisma: MockPrisma;
  let audits: MockAudits;
  let opportunities: MockOpportunities;
  let notifications: MockNotifications;
  let odcApplications: MockOdcApplications;
  let registry: OpsActionsRegistryService;

  beforeEach(() => {
    prisma = {
      website: { count: jest.fn().mockResolvedValue(2) },
      audit: { findFirst: jest.fn().mockResolvedValue(null) },
      opportunity: { count: jest.fn().mockResolvedValue(3) },
      actionItem: {
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockResolvedValue({
          id: 'action-1',
          title: 'Nouvelle tâche',
          approvalStatus: 'draft',
          executionStatus: 'not_started',
        }),
      },
    };
    audits = {
      run: jest.fn().mockResolvedValue({
        id: 'audit-1',
        status: 'completed',
        globalScore: 72,
      }),
    };
    opportunities = {
      generateFromAudit: jest
        .fn()
        .mockResolvedValue([{ id: 'opp-1' }, { id: 'opp-2' }]),
    };
    notifications = {
      createEmailDelivery: jest.fn().mockResolvedValue({
        delivery: {
          id: 'delivery-1',
          channel: 'email',
          templateKey: 'audit_completed',
          status: 'pending',
        },
        recipientEmail: 'jane@example.com',
      }),
    };
    odcApplications = {
      prepareApplicationSummary: jest
        .fn()
        .mockResolvedValue({ skipped: false, summaryDraft: 'Résumé.' }),
      recomputeMissingDocuments: jest.fn().mockResolvedValue({
        changed: true,
        application: { status: 'in_review', missing: null },
      }),
      createReviewTask: jest.fn().mockResolvedValue({
        actionItemId: 'action-2',
        title: 'Revue de candidature',
      }),
    };
    registry = new OpsActionsRegistryService(
      prisma as unknown as PrismaService,
      audits as unknown as AuditsService,
      opportunities as unknown as OpportunitiesService,
      notifications as unknown as NotificationsService,
      odcApplications as unknown as OdcApplicationsService,
    );
  });

  describe('allowlist', () => {
    it('lists exactly the 8 safe, internal ROBIA actions', () => {
      const types = registry.listAllowedActions().map((a) => a.type);
      expect(types.sort()).toEqual(
        [
          'robia.action_items.create_internal_task',
          'robia.audit.run_diagnostic',
          'robia.notification.send_email',
          'robia.opportunities.regenerate',
          'robia.report.prepare_organization_summary',
          'robia.odc.prepare_application_summary',
          'robia.odc.flag_missing_documents',
          'robia.odc.create_review_task',
        ].sort(),
      );
    });

    it.each([
      'shell.exec',
      'sql.raw_query',
      'http.fetch_url',
      'github.merge_pull_request',
      'deploy.production',
      'database.delete_all',
      'meta.publish_post',
      'gbp.publish_post',
      // RC-29 — the AI/automations must never be able to decide a
      // candidature: no such action is ever registered, at all.
      'robia.odc.decide',
    ])('rejects the non-allowlisted action "%s"', async (actionType) => {
      expect(registry.isAllowed(actionType)).toBe(false);
      await expect(
        registry.execute(actionType, organizationId, {}),
      ).rejects.toBeInstanceOf(UnknownOpsActionError);
    });
  });

  describe('robia.audit.run_diagnostic', () => {
    it('runs a diagnostic for the given website, scoped to the organization', async () => {
      const evidence = await registry.execute(
        'robia.audit.run_diagnostic',
        organizationId,
        { websiteId: 'site-1' },
      );
      expect(audits.run).toHaveBeenCalledWith(organizationId, 'site-1');
      expect(evidence).toEqual({
        auditId: 'audit-1',
        websiteId: 'site-1',
        status: 'completed',
        globalScore: 72,
      });
    });

    it('rejects a missing websiteId input', async () => {
      await expect(
        registry.execute('robia.audit.run_diagnostic', organizationId, {}),
      ).rejects.toBeInstanceOf(InvalidOpsActionInputError);
      expect(audits.run).not.toHaveBeenCalled();
    });
  });

  describe('robia.opportunities.regenerate', () => {
    it('delegates to OpportunitiesService.generateFromAudit and reports the count', async () => {
      const evidence = await registry.execute(
        'robia.opportunities.regenerate',
        organizationId,
        { auditId: 'audit-1' },
      );
      expect(opportunities.generateFromAudit).toHaveBeenCalledWith(
        organizationId,
        'audit-1',
      );
      expect(evidence).toEqual({
        auditId: 'audit-1',
        opportunityCount: 2,
        opportunityIds: ['opp-1', 'opp-2'],
      });
    });

    it('rejects a missing auditId input', async () => {
      await expect(
        registry.execute('robia.opportunities.regenerate', organizationId, {}),
      ).rejects.toBeInstanceOf(InvalidOpsActionInputError);
      expect(opportunities.generateFromAudit).not.toHaveBeenCalled();
    });
  });

  describe('robia.report.prepare_organization_summary', () => {
    it('aggregates read-only counts scoped to the organization', async () => {
      const evidence = await registry.execute(
        'robia.report.prepare_organization_summary',
        organizationId,
        {},
      );
      expect(prisma.website.count).toHaveBeenCalledWith({
        where: { organizationId },
      });
      expect(prisma.opportunity.count).toHaveBeenCalledWith({
        where: { organizationId, status: 'open' },
      });
      expect(prisma.actionItem.count).toHaveBeenCalledWith({
        where: { organizationId, status: 'todo' },
      });
      expect(evidence).toMatchObject({
        websiteCount: 2,
        latestAudit: null,
        openOpportunityCount: 3,
        pendingActionCount: 1,
      });
      expect(typeof (evidence as { generatedAt: string }).generatedAt).toBe(
        'string',
      );
    });
  });

  describe('robia.action_items.create_internal_task', () => {
    it('creates a draft ActionItem, never auto-approved or executed', async () => {
      const evidence = await registry.execute(
        'robia.action_items.create_internal_task',
        organizationId,
        { title: 'Vérifier le certificat SSL' },
      );
      expect(prisma.actionItem.create).toHaveBeenCalledWith({
        data: {
          organizationId,
          title: 'Vérifier le certificat SSL',
          status: 'todo',
        },
      });
      expect(evidence).toEqual({
        actionItemId: 'action-1',
        title: 'Nouvelle tâche',
        approvalStatus: 'draft',
        executionStatus: 'not_started',
      });
    });

    it('rejects a missing title input', async () => {
      await expect(
        registry.execute(
          'robia.action_items.create_internal_task',
          organizationId,
          {},
        ),
      ).rejects.toBeInstanceOf(InvalidOpsActionInputError);
      expect(prisma.actionItem.create).not.toHaveBeenCalled();
    });
  });

  describe('robia.notification.send_email', () => {
    it('returns explicit routing evidence when n8n owns the audit email', async () => {
      notifications.createEmailDelivery.mockResolvedValue({
        delivery: null,
        recipientEmail: '',
        reason: 'handled_by_n8n',
      });
      const evidence = await registry.execute(
        'robia.notification.send_email',
        organizationId,
        { templateKey: 'audit_completed' },
        { automationId: 'auto-1', runId: 'run-1', stepRunId: 'step-1' },
      );
      expect(evidence).toEqual({
        channel: 'email',
        templateKey: 'audit_completed',
        status: 'skipped',
        reason: 'handled_by_n8n',
      });
    });
    it('drops an arbitrary caller-supplied recipient field — canonicalizeInput only ever keeps templateKey/templateData', () => {
      const canonical = registry.canonicalizeInput(
        'robia.notification.send_email',
        {
          templateKey: 'audit_completed',
          templateData: { websiteUrl: 'https://example.com', globalScore: 82 },
          to: 'attacker@evil.example',
          recipientEmail: 'attacker@evil.example',
          replyTo: 'attacker@evil.example',
        },
      );
      expect(canonical).toEqual({
        templateKey: 'audit_completed',
        templateData: { websiteUrl: 'https://example.com', globalScore: 82 },
      });
      expect(JSON.stringify(canonical)).not.toContain('evil.example');
    });

    it('delegates to NotificationsService.createEmailDelivery with the trusted execution context, never a caller-supplied recipient', async () => {
      const evidence = await registry.execute(
        'robia.notification.send_email',
        organizationId,
        {
          templateKey: 'audit_completed',
          templateData: { websiteUrl: 'https://example.com', globalScore: 82 },
        },
        executionContext,
      );
      expect(notifications.createEmailDelivery).toHaveBeenCalledWith({
        organizationId,
        automationId: executionContext.automationId,
        automationRunId: executionContext.runId,
        automationStepRunId: executionContext.stepRunId,
        templateKey: 'audit_completed',
        templateData: { websiteUrl: 'https://example.com', globalScore: 82 },
      });
      expect(evidence).toEqual({
        deliveryId: 'delivery-1',
        channel: 'email',
        templateKey: 'audit_completed',
        status: 'pending',
        recipientMasked: 'j***@example.com',
      });
    });

    it('never returns the full recipient address in its evidence', async () => {
      const evidence = await registry.execute(
        'robia.notification.send_email',
        organizationId,
        { templateKey: 'audit_completed', templateData: {} },
        executionContext,
      );
      expect(JSON.stringify(evidence)).not.toContain('jane@example.com');
    });

    it('rejects a missing templateKey input', async () => {
      await expect(
        registry.execute(
          'robia.notification.send_email',
          organizationId,
          { templateData: {} },
          executionContext,
        ),
      ).rejects.toBeInstanceOf(InvalidOpsActionInputError);
      expect(notifications.createEmailDelivery).not.toHaveBeenCalled();
    });

    it('defaults templateData to {} when absent', async () => {
      await registry.execute(
        'robia.notification.send_email',
        organizationId,
        { templateKey: 'audit_completed' },
        executionContext,
      );
      expect(notifications.createEmailDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ templateData: {} }),
      );
    });

    it('throws when invoked without an execution context', async () => {
      await expect(
        registry.execute('robia.notification.send_email', organizationId, {
          templateKey: 'audit_completed',
        }),
      ).rejects.toBeInstanceOf(InvalidOpsActionInputError);
      expect(notifications.createEmailDelivery).not.toHaveBeenCalled();
    });

    // RC-26 review fix: auditId (optionalInputSchema) forwarded through to
    // NotificationsService, which is what resolves audit_completed's real
    // data — see notifications.service.ts's resolveTemplateData().
    it('forwards auditId through to createEmailDelivery when present', async () => {
      await registry.execute(
        'robia.notification.send_email',
        organizationId,
        { templateKey: 'audit_completed', auditId: 'audit-42' },
        executionContext,
      );
      expect(notifications.createEmailDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ auditId: 'audit-42' }),
      );
    });

    it('omits auditId when absent, never defaulting it to an empty string', async () => {
      await registry.execute(
        'robia.notification.send_email',
        organizationId,
        { templateKey: 'automation_failed', templateData: {} },
        executionContext,
      );
      expect(notifications.createEmailDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ auditId: undefined }),
      );
    });
  });

  describe('canonicalizeInput', () => {
    it('strips any key not declared by the action, keeping only its own allowlisted fields', () => {
      const canonical = registry.canonicalizeInput(
        'robia.action_items.create_internal_task',
        { title: 'Vérifier le site', token: 'super-secret', apiKey: 'sk-123' },
      );
      expect(canonical).toEqual({ title: 'Vérifier le site' });
    });

    it('returns an empty object for an action that declares no input fields, dropping everything passed in', () => {
      const canonical = registry.canonicalizeInput(
        'robia.report.prepare_organization_summary',
        { anything: 'goes-here', password: 'hunter2' },
      );
      expect(canonical).toEqual({});
    });

    it('still enforces the required-field check before canonicalizing', () => {
      expect(() =>
        registry.canonicalizeInput('robia.audit.run_diagnostic', {
          token: 'super-secret',
        }),
      ).toThrow(InvalidOpsActionInputError);
    });

    it('rejects a non-allowlisted action type', () => {
      expect(() =>
        registry.canonicalizeInput('shell.exec', { cmd: 'rm -rf /' }),
      ).toThrow(UnknownOpsActionError);
    });

    it('keeps a declared object field (objectInputFields), stripping keys not part of it', () => {
      const canonical = registry.canonicalizeInput(
        'robia.notification.send_email',
        {
          templateKey: 'audit_completed',
          templateData: { websiteUrl: 'https://example.com' },
          extraneous: 'dropped',
        },
      );
      expect(canonical).toEqual({
        templateKey: 'audit_completed',
        templateData: { websiteUrl: 'https://example.com' },
      });
    });

    it('defaults a declared object field to {} when absent', () => {
      const canonical = registry.canonicalizeInput(
        'robia.notification.send_email',
        { templateKey: 'audit_completed' },
      );
      expect(canonical).toEqual({
        templateKey: 'audit_completed',
        templateData: {},
      });
    });

    // RC-26 review fix: optionalInputSchema (auditId).
    it('keeps a declared optional field (optionalInputSchema) when present', () => {
      const canonical = registry.canonicalizeInput(
        'robia.notification.send_email',
        { templateKey: 'audit_completed', auditId: 'audit-42' },
      );
      expect(canonical).toEqual({
        templateKey: 'audit_completed',
        templateData: {},
        auditId: 'audit-42',
      });
    });

    it('never requires a declared optional field to be present', () => {
      const canonical = registry.canonicalizeInput(
        'robia.notification.send_email',
        { templateKey: 'automation_failed' },
      );
      expect(canonical).not.toHaveProperty('auditId');
    });

    it('rejects a declared object field that is an array', () => {
      expect(() =>
        registry.canonicalizeInput('robia.notification.send_email', {
          templateKey: 'audit_completed',
          templateData: ['not', 'an', 'object'],
        }),
      ).toThrow(InvalidOpsActionInputError);
    });

    it('never lets a templated placeholder value be rejected as invalid — it is still just a non-empty string', () => {
      const canonical = registry.canonicalizeInput(
        'robia.opportunities.regenerate',
        { auditId: '{{event.auditId}}' },
      );
      expect(canonical).toEqual({ auditId: '{{event.auditId}}' });
    });
  });

  describe('robia.odc.prepare_application_summary', () => {
    it('delegates to OdcApplicationsService.prepareApplicationSummary and returns its result', async () => {
      const evidence = await registry.execute(
        'robia.odc.prepare_application_summary',
        organizationId,
        { applicationId: 'app-1' },
      );
      expect(odcApplications.prepareApplicationSummary).toHaveBeenCalledWith(
        organizationId,
        'app-1',
      );
      expect(evidence).toEqual({
        applicationId: 'app-1',
        skipped: false,
        summaryDraft: 'Résumé.',
      });
    });
  });

  describe('robia.odc.flag_missing_documents', () => {
    it('delegates to OdcApplicationsService.recomputeMissingDocuments and reports the resulting status', async () => {
      const evidence = await registry.execute(
        'robia.odc.flag_missing_documents',
        organizationId,
        { applicationId: 'app-1' },
      );
      expect(odcApplications.recomputeMissingDocuments).toHaveBeenCalledWith(
        organizationId,
        'app-1',
      );
      expect(evidence).toEqual({
        applicationId: 'app-1',
        changed: true,
        status: 'in_review',
        missing: null,
      });
    });
  });

  describe('robia.odc.create_review_task', () => {
    it('delegates to OdcApplicationsService.createReviewTask — the title is never caller-supplied', async () => {
      const evidence = await registry.execute(
        'robia.odc.create_review_task',
        organizationId,
        { applicationId: 'app-1', title: 'Ignored, never read' },
      );
      expect(odcApplications.createReviewTask).toHaveBeenCalledWith(
        organizationId,
        'app-1',
      );
      expect(evidence).toEqual({
        applicationId: 'app-1',
        actionItemId: 'action-2',
        title: 'Revue de candidature',
      });
    });
  });

  // RC-27 hardening — the replay policy every step-level retry decision in
  // AutomationsService reads via isRetrySafe(). "Never rejouable by
  // default": the only 4 actions marked retry-safe are the ones with a
  // provable reason (read-only, or an already-idempotent underlying
  // service call) — everything else defaults to false, including two
  // actions the hardening spec never had to name explicitly
  // (robia.odc.create_review_task creates a fresh row exactly like
  // robia.action_items.create_internal_task does; robia.odc.
  // flag_missing_documents appends an append-only history row on every
  // call, even a no-op recompute).
  describe('isRetrySafe (RC-27)', () => {
    it.each<[string, boolean]>([
      ['robia.audit.run_diagnostic', false],
      ['robia.opportunities.regenerate', true],
      ['robia.report.prepare_organization_summary', true],
      ['robia.action_items.create_internal_task', false],
      ['robia.notification.send_email', true],
      ['robia.odc.prepare_application_summary', true],
      ['robia.odc.flag_missing_documents', false],
      ['robia.odc.create_review_task', false],
    ])('%s -> retrySafe=%s', (actionType, expected) => {
      expect(registry.isRetrySafe(actionType)).toBe(expected);
    });

    it('is false for an unknown/unallowed action type', () => {
      expect(registry.isRetrySafe('robia.not.a.real.action')).toBe(false);
    });
  });
});
