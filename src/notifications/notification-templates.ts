// RC-26 — the notification template allowlist.
//
// This list *is* the allowlist, the same discipline as
// OpsActionsRegistryService's action allowlist: a `templateKey` only ever
// produces an email if it is an exact key of NOTIFICATION_TEMPLATES below.
// There is deliberately no "free-form template" stored on an Automation
// step and no way to reach one — subject and body text are always produced
// here, server-side, from a fixed string plus a strictly validated set of
// variables.

export type NotificationTemplateKey =
  | 'audit_completed'
  | 'automation_failed'
  | 'weekly_opportunities_summary'
  | 'odc_candidate_invite';

export class UnknownNotificationTemplateError extends Error {
  constructor(templateKey: string) {
    super(`"${templateKey}" is not an allowlisted notification template.`);
  }
}

export class InvalidNotificationTemplateDataError extends Error {}

// Bounds a single variable's rendered length — generous enough for a URL
// or a short name, small enough that a template can never be used to smuggle
// an oversized payload into an email.
const MAX_VARIABLE_LENGTH = 200;

// Header-injection guard: every variable ends up substituted into the
// subject line (not only the body), so a value containing a CR/LF could, in
// principle, be used to inject extra headers into the outgoing message. No
// template variable in this allowlist ever legitimately needs a line break.
const FORBIDDEN_CHARACTERS_PATTERN = /[\r\n]/;

interface NotificationTemplateDescriptor {
  // The exhaustive list of variables this template ever reads. Exactly
  // this set must be present in templateData — never more (an unknown key
  // is rejected, the same discipline as the Ops action registry's
  // inputSchema), never fewer.
  variables: string[];
  subject: (data: Record<string, string>) => string;
  text: (data: Record<string, string>) => string;
}

const NOTIFICATION_TEMPLATES: Record<
  NotificationTemplateKey,
  NotificationTemplateDescriptor
> = {
  // RC-26 review fix: `scoreLine` (not a raw `globalScore` number) is
  // deliberately a fully pre-formatted string — "82/100" or "non
  // disponible" — computed by NotificationsService.createEmailDelivery()
  // from the real Audit record (see its own resolveAuditCompletedData()).
  // An absent score (Audit.globalScore === null, e.g. an audit path that
  // never computes one) is handled explicitly there, not here: the
  // template itself never has to special-case "no score" formatting.
  audit_completed: {
    variables: ['websiteUrl', 'scoreLine'],
    subject: (data) => `Audit terminé pour ${data.websiteUrl}`,
    text: (data) =>
      [
        `L'audit de ${data.websiteUrl} est terminé.`,
        `Score global : ${data.scoreLine}.`,
        '',
        'Ceci est une notification automatique ROBIA.',
      ].join('\n'),
  },
  automation_failed: {
    variables: ['automationName', 'errorMessage'],
    subject: (data) => `Échec de l'automatisation « ${data.automationName} »`,
    text: (data) =>
      [
        `L'automatisation « ${data.automationName} » a échoué.`,
        `Détail : ${data.errorMessage}`,
        '',
        'Ceci est une notification automatique ROBIA.',
      ].join('\n'),
  },
  weekly_opportunities_summary: {
    variables: ['organizationName', 'openOpportunityCount'],
    subject: () => 'Résumé hebdomadaire des opportunités ROBIA',
    text: (data) =>
      [
        `Organisation : ${data.organizationName}`,
        `Opportunités ouvertes : ${data.openOpportunityCount}`,
        '',
        'Ceci est une notification automatique ROBIA.',
      ].join('\n'),
  },
  // RC-31 — candidate invite. Variables are resolved server-side from the
  // application + program; the client never supplies the recipient or body.
  odc_candidate_invite: {
    variables: ['applicantName', 'programName'],
    subject: (data) => `Candidature « ${data.programName} » — prochaine étape`,
    text: (data) =>
      [
        `Bonjour ${data.applicantName},`,
        '',
        `Votre dossier pour « ${data.programName} » a été présélectionné.`,
        'Nous vous recontactons pour la suite du processus.',
        '',
        '— Orange Digital Center',
      ].join('\n'),
  },
};

export function isKnownNotificationTemplate(
  templateKey: string,
): templateKey is NotificationTemplateKey {
  return templateKey in NOTIFICATION_TEMPLATES;
}

export function listNotificationTemplateKeys(): NotificationTemplateKey[] {
  return Object.keys(NOTIFICATION_TEMPLATES) as NotificationTemplateKey[];
}

export interface RenderedNotification {
  subject: string;
  text: string;
}

// The single place that turns (templateKey, templateData) into the actual
// subject/body text that gets sent — called both when a delivery is created
// (so bad data is rejected immediately, not silently deferred to send time)
// and again by the dispatcher right before sending (never storing
// pre-rendered text, so a template fix can apply to an already-queued,
// not-yet-sent delivery).
export function renderNotificationTemplate(
  templateKey: string,
  templateData: unknown,
): RenderedNotification {
  if (!isKnownNotificationTemplate(templateKey)) {
    throw new UnknownNotificationTemplateError(templateKey);
  }
  const template = NOTIFICATION_TEMPLATES[templateKey];
  const data = validateTemplateData(template.variables, templateData);
  return {
    subject: template.subject(data),
    text: template.text(data),
  };
}

function validateTemplateData(
  variables: string[],
  templateData: unknown,
): Record<string, string> {
  if (
    templateData === null ||
    typeof templateData !== 'object' ||
    Array.isArray(templateData)
  ) {
    throw new InvalidNotificationTemplateDataError(
      'templateData must be a plain object.',
    );
  }
  const input = templateData as Record<string, unknown>;
  const inputKeys = Object.keys(input);

  const unknownKeys = inputKeys.filter((key) => !variables.includes(key));
  if (unknownKeys.length > 0) {
    throw new InvalidNotificationTemplateDataError(
      `Unknown template variable(s): ${unknownKeys.join(', ')}.`,
    );
  }

  const result: Record<string, string> = {};
  for (const variable of variables) {
    const value = input[variable];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new InvalidNotificationTemplateDataError(
        `Missing or invalid template variable "${variable}".`,
      );
    }
    const stringValue = String(value);
    if (stringValue.length === 0) {
      throw new InvalidNotificationTemplateDataError(
        `Missing or invalid template variable "${variable}".`,
      );
    }
    if (stringValue.length > MAX_VARIABLE_LENGTH) {
      throw new InvalidNotificationTemplateDataError(
        `Template variable "${variable}" exceeds the maximum length of ${MAX_VARIABLE_LENGTH} characters.`,
      );
    }
    if (FORBIDDEN_CHARACTERS_PATTERN.test(stringValue)) {
      throw new InvalidNotificationTemplateDataError(
        `Template variable "${variable}" contains a forbidden line-break character.`,
      );
    }
    result[variable] = stringValue;
  }
  return result;
}
