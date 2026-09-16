import {
  InvalidNotificationTemplateDataError,
  UnknownNotificationTemplateError,
  isKnownNotificationTemplate,
  listNotificationTemplateKeys,
  renderNotificationTemplate,
} from './notification-templates';

describe('notification-templates', () => {
  describe('allowlist', () => {
    it('lists exactly the 3 allowlisted templates', () => {
      expect(listNotificationTemplateKeys().sort()).toEqual(
        [
          'audit_completed',
          'automation_failed',
          'weekly_opportunities_summary',
        ].sort(),
      );
    });

    it('rejects a template key not in the allowlist', () => {
      expect(isKnownNotificationTemplate('free_form_template')).toBe(false);
      expect(() =>
        renderNotificationTemplate('free_form_template', {}),
      ).toThrow(UnknownNotificationTemplateError);
    });
  });

  describe('audit_completed', () => {
    it('renders subject and text from valid variables', () => {
      const rendered = renderNotificationTemplate('audit_completed', {
        websiteUrl: 'https://example.com',
        globalScore: 82,
      });
      expect(rendered.subject).toBe('Audit terminé pour https://example.com');
      expect(rendered.text).toContain('https://example.com');
      expect(rendered.text).toContain('82/100');
    });

    it('rejects an unknown variable', () => {
      expect(() =>
        renderNotificationTemplate('audit_completed', {
          websiteUrl: 'https://example.com',
          globalScore: 82,
          unexpected: 'value',
        }),
      ).toThrow(InvalidNotificationTemplateDataError);
    });

    it('rejects a missing required variable', () => {
      expect(() =>
        renderNotificationTemplate('audit_completed', {
          websiteUrl: 'https://example.com',
        }),
      ).toThrow(InvalidNotificationTemplateDataError);
    });

    it('rejects templateData that is not a plain object', () => {
      expect(() =>
        renderNotificationTemplate('audit_completed', 'not-an-object'),
      ).toThrow(InvalidNotificationTemplateDataError);
      expect(() =>
        renderNotificationTemplate('audit_completed', [
          'websiteUrl',
          'globalScore',
        ]),
      ).toThrow(InvalidNotificationTemplateDataError);
      expect(() => renderNotificationTemplate('audit_completed', null)).toThrow(
        InvalidNotificationTemplateDataError,
      );
    });

    it('rejects a value exceeding the maximum length', () => {
      expect(() =>
        renderNotificationTemplate('audit_completed', {
          websiteUrl: 'https://example.com/'.padEnd(300, 'a'),
          globalScore: 82,
        }),
      ).toThrow(InvalidNotificationTemplateDataError);
    });

    it('rejects a value containing a header-injection line break', () => {
      expect(() =>
        renderNotificationTemplate('audit_completed', {
          websiteUrl: 'https://example.com\r\nBcc: attacker@evil.example',
          globalScore: 82,
        }),
      ).toThrow(InvalidNotificationTemplateDataError);
    });

    it('rejects an empty-string value', () => {
      expect(() =>
        renderNotificationTemplate('audit_completed', {
          websiteUrl: '',
          globalScore: 82,
        }),
      ).toThrow(InvalidNotificationTemplateDataError);
    });
  });

  describe('automation_failed', () => {
    it('renders subject and text from valid variables', () => {
      const rendered = renderNotificationTemplate('automation_failed', {
        automationName: 'Régénérer les opportunités',
        errorMessage: 'Timeout',
      });
      expect(rendered.subject).toContain('Régénérer les opportunités');
      expect(rendered.text).toContain('Timeout');
    });
  });

  describe('weekly_opportunities_summary', () => {
    it('renders subject and text from valid variables', () => {
      const rendered = renderNotificationTemplate(
        'weekly_opportunities_summary',
        { organizationName: 'ACME', openOpportunityCount: 4 },
      );
      expect(rendered.subject).toBe(
        'Résumé hebdomadaire des opportunités ROBIA',
      );
      expect(rendered.text).toContain('ACME');
      expect(rendered.text).toContain('4');
    });
  });
});
