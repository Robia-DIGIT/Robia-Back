import { PrismaService } from '../../prisma/prisma.service';
import { AuditsService } from '../../audits/audits.service';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
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

describe('OpsActionsRegistryService', () => {
  const organizationId = 'org-1';
  let prisma: MockPrisma;
  let audits: MockAudits;
  let opportunities: MockOpportunities;
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
    registry = new OpsActionsRegistryService(
      prisma as unknown as PrismaService,
      audits as unknown as AuditsService,
      opportunities as unknown as OpportunitiesService,
    );
  });

  describe('allowlist', () => {
    it('lists exactly the 4 safe, internal ROBIA actions', () => {
      const types = registry.listAllowedActions().map((a) => a.type);
      expect(types.sort()).toEqual(
        [
          'robia.action_items.create_internal_task',
          'robia.audit.run_diagnostic',
          'robia.opportunities.regenerate',
          'robia.report.prepare_organization_summary',
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

    it('never lets a templated placeholder value be rejected as invalid — it is still just a non-empty string', () => {
      const canonical = registry.canonicalizeInput(
        'robia.opportunities.regenerate',
        { auditId: '{{event.auditId}}' },
      );
      expect(canonical).toEqual({ auditId: '{{event.auditId}}' });
    });
  });
});
