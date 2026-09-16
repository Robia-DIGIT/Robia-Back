import { CreateAutomationDto } from '../dto/create-automation.dto';
import { AutomationsService } from '../automations.service';

/**
 * RC-20 demonstration automations. Every one of these is defined with
 * `enabled: false` and none is created anywhere automatically — nothing in
 * this codebase imports `seedExampleAutomations()` from app bootstrap, a
 * module, or a migration. They exist to show the intended shape of a real
 * Automation, and to be exercised by tests (automation-examples.spec.ts)
 * proving they stay valid against the real condition engine and action
 * allowlist as both evolve.
 *
 * To actually create one of these for an organization, an operator calls
 * `seedExampleAutomations()` explicitly (e.g. from a one-off script or a
 * Nest REPL session) — never as a side effect of starting the app.
 */
export const EXAMPLE_AUTOMATIONS: CreateAutomationDto[] = [
  {
    name: 'Régénérer les opportunités après un audit terminé',
    description:
      'Quand un audit se termine, complète automatiquement les opportunités ROBIA (SEO + Meta) pour cet audit — additif uniquement, jamais de suppression (RC-19).',
    enabled: false,
    requiresApproval: false,
    trigger: {
      type: 'event',
      eventType: 'audit.completed',
    },
    conditions: {
      field: 'audit.status',
      operator: 'eq',
      value: 'completed',
    },
    steps: [
      {
        actionType: 'robia.opportunities.regenerate',
        input: { auditId: '{{event.auditId}}' },
      },
    ],
  },
  {
    name: "Créer une alerte interne lorsqu'une intégration devient indisponible",
    description:
      "Quand une intégration (Google Search Console ou Meta) devient déconnectée, crée une tâche ROBIA interne en brouillon pour qu'un humain vérifie la connexion — jamais d'action automatique sur l'intégration elle-même.",
    enabled: false,
    requiresApproval: false,
    trigger: {
      type: 'event',
      eventType: 'integration.disconnected',
    },
    steps: [
      {
        actionType: 'robia.action_items.create_internal_task',
        input: {
          title:
            'Une intégration ROBIA est devenue indisponible — vérifier la connexion.',
        },
      },
    ],
  },
  {
    name: "Préparer un rapport d'organisation sur demande",
    description:
      "Lancée manuellement, prépare un résumé en lecture seule de l'organisation (sites, dernier audit, opportunités ouvertes, tâches en attente).",
    enabled: false,
    requiresApproval: false,
    trigger: { type: 'manual' },
    steps: [
      {
        actionType: 'robia.report.prepare_organization_summary',
      },
    ],
  },
  {
    // RC-26: must stay enabled: false until the SMTP channel has been
    // configured (NOTIFICATIONS_ENABLED + SMTP_*) and manually validated —
    // see docs/RC26_NOTIFICATION_DELIVERY.md's activation procedure. Never
    // flipped to true anywhere in this codebase.
    //
    // Single owner of the "audit terminé" email: while NOTIFICATIONS_ENABLED
    // is "true", OpportunitiesService.generateFromAudit() (the existing
    // "Régénérer les opportunités" example below, or a direct call) no
    // longer fires the n8n audit-completed webhook — this automation, once
    // also enabled, is what takes over that responsibility. See
    // docs/RC26_NOTIFICATION_DELIVERY.md's "Bascule email audit — un seul
    // responsable".
    name: "Notifier par email la fin d'un audit",
    description:
      "Quand un audit se termine, envoie un email au créateur de l'automatisation (template allowlisté audit_completed, données relues depuis l'audit) — nécessite un canal SMTP configuré et validé avant activation ; désactive automatiquement le webhook n8n équivalent une fois NOTIFICATIONS_ENABLED=true.",
    enabled: false,
    requiresApproval: false,
    trigger: {
      type: 'event',
      eventType: 'audit.completed',
    },
    conditions: {
      field: 'audit.status',
      operator: 'eq',
      value: 'completed',
    },
    steps: [
      {
        actionType: 'robia.notification.send_email',
        input: {
          templateKey: 'audit_completed',
          // Real audit.completed event fields only (see
          // audit-completed.event.ts) — websiteUrl/scoreLine are resolved
          // server-side from the Audit record itself, org-scoped, never
          // from this step's own (static) input. See
          // NotificationsService.resolveTemplateData().
          auditId: '{{event.auditId}}',
        },
      },
    ],
  },
];

export async function seedExampleAutomations(
  automations: AutomationsService,
  organizationId: string,
  createdById: string,
) {
  const created: Awaited<ReturnType<AutomationsService['create']>>[] = [];
  for (const example of EXAMPLE_AUTOMATIONS) {
    created.push(
      await automations.create(organizationId, createdById, example),
    );
  }
  return created;
}
