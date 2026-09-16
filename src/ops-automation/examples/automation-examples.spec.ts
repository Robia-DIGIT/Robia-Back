import { PrismaService } from '../../prisma/prisma.service';
import { AuditsService } from '../../audits/audits.service';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { OpsActionsRegistryService } from '../actions/ops-actions-registry.service';
import { validateConditionTree } from '../condition-engine';
import { resolveStepInput } from '../automation-templating';
import { EXAMPLE_AUTOMATIONS } from './automation-examples';

describe('RC-20 demonstration automations', () => {
  // Constructed with no real dependencies: isAllowed() only reads the
  // registry's own internal map, built in the constructor without ever
  // calling prisma/audits/opportunities/notifications.
  const registry = new OpsActionsRegistryService(
    {} as unknown as PrismaService,
    {} as unknown as AuditsService,
    {} as unknown as OpportunitiesService,
    {} as unknown as NotificationsService,
  );

  it('ships exactly the 4 named examples, all disabled', () => {
    expect(EXAMPLE_AUTOMATIONS).toHaveLength(4);
    expect(EXAMPLE_AUTOMATIONS.map((a) => a.name)).toEqual([
      'Régénérer les opportunités après un audit terminé',
      "Créer une alerte interne lorsqu'une intégration devient indisponible",
      "Préparer un rapport d'organisation sur demande",
      "Notifier par email la fin d'un audit",
    ]);
    EXAMPLE_AUTOMATIONS.forEach((example) => {
      expect(example.enabled).toBe(false);
    });
  });

  it('gives every example a valid trigger', () => {
    for (const example of EXAMPLE_AUTOMATIONS) {
      expect(['manual', 'scheduled', 'event']).toContain(example.trigger.type);
      if (example.trigger.type === 'event') {
        expect(typeof example.trigger.eventType).toBe('string');
      }
      if (example.trigger.type === 'scheduled') {
        expect(typeof example.trigger.cronExpression).toBe('string');
      }
    }
  });

  it('gives every example only allowlisted action types', () => {
    for (const example of EXAMPLE_AUTOMATIONS) {
      for (const step of example.steps) {
        expect(registry.isAllowed(step.actionType)).toBe(true);
      }
    }
  });

  it('gives every example a condition tree that passes validation, when present', () => {
    for (const example of EXAMPLE_AUTOMATIONS) {
      if (example.conditions) {
        expect(() => validateConditionTree(example.conditions!)).not.toThrow();
      }
    }
  });

  it('never bakes a raw secret or token into a step input', () => {
    const serialized = JSON.stringify(EXAMPLE_AUTOMATIONS);
    expect(serialized).not.toMatch(/token|secret|password|api[-_]?key/i);
  });

  it("resolves the audit-completed example's templated input from a real event payload", () => {
    const [regenerateOpportunities] = EXAMPLE_AUTOMATIONS;
    const [step] = regenerateOpportunities.steps;
    const resolved = resolveStepInput(step.input, { auditId: 'audit-42' });
    expect(resolved).toEqual({ auditId: 'audit-42' });
  });

  // RC-26 review fix: the real audit.completed event only ever carries
  // auditId/websiteId/globalScore (see audit-completed.event.ts) — never a
  // websiteUrl — so this example passes auditId through and lets
  // NotificationsService resolve websiteUrl/scoreLine from the real Audit
  // record itself, org-scoped.
  it("resolves the notify-by-email example's auditId from a real event payload", () => {
    const notifyByEmail = EXAMPLE_AUTOMATIONS.find(
      (a) => a.name === "Notifier par email la fin d'un audit",
    )!;
    const [step] = notifyByEmail.steps;
    const resolved = resolveStepInput(step.input, {
      auditId: 'audit-42',
      websiteId: 'website-1',
      globalScore: 91,
    });
    expect(resolved).toEqual({
      templateKey: 'audit_completed',
      auditId: 'audit-42',
    });
  });
});
