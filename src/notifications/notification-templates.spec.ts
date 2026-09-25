import {
  InvalidNotificationTemplateDataError,
  UnknownNotificationTemplateError,
  isKnownNotificationTemplate,
  listNotificationTemplateKeys,
  renderNotificationTemplate,
} from './notification-templates';

describe('notification-templates', () => {
  describe('allowlist', () => {
    it('lists exactly the 5 allowlisted templates', () => {
      expect(listNotificationTemplateKeys().sort()).toEqual(
        [
          'audit_completed',
          'automation_failed',
          'odc_applicant_magic_link',
          'odc_candidate_invite',
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
        scoreLine: '82/100',
      });
      expect(rendered.subject).toBe('Audit terminé pour https://example.com');
      expect(rendered.text).toContain('https://example.com');
      expect(rendered.text).toContain('82/100');
    });

    // RC-26 review fix: an absent score is handled explicitly upstream
    // (NotificationsService.resolveAuditCompletedData()) by passing a
    // pre-formatted "non disponible" string rather than leaving the
    // template to render "null/100" or similar.
    it('renders a pre-formatted "no score" line without needing template-level special-casing', () => {
      const rendered = renderNotificationTemplate('audit_completed', {
        websiteUrl: 'https://example.com',
        scoreLine: 'non disponible',
      });
      expect(rendered.text).toContain('Score global : non disponible.');
      expect(rendered.text).not.toContain('null');
      expect(rendered.text).not.toContain('undefined');
    });

    it('rejects an unknown variable', () => {
      expect(() =>
        renderNotificationTemplate('audit_completed', {
          websiteUrl: 'https://example.com',
          scoreLine: '82/100',
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
          'scoreLine',
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
          scoreLine: '82/100',
        }),
      ).toThrow(InvalidNotificationTemplateDataError);
    });

    it('rejects a value containing a header-injection line break', () => {
      expect(() =>
        renderNotificationTemplate('audit_completed', {
          websiteUrl: 'https://example.com\r\nBcc: attacker@evil.example',
          scoreLine: '82/100',
        }),
      ).toThrow(InvalidNotificationTemplateDataError);
    });

    it('rejects an empty-string value', () => {
      expect(() =>
        renderNotificationTemplate('audit_completed', {
          websiteUrl: '',
          scoreLine: '82/100',
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

  describe('odc_candidate_invite', () => {
    it('renders a candidate invite without injecting caller-supplied addresses', () => {
      const rendered = renderNotificationTemplate('odc_candidate_invite', {
        applicantName: 'Aina R.',
        programName: 'ODC 2026',
      });
      expect(rendered.subject).toContain('ODC 2026');
      expect(rendered.text).toContain('Aina R.');
      expect(rendered.text).not.toMatch(/@/);
    });
  });

  describe('odc_applicant_magic_link', () => {
    it('renders the magic link URL verbatim in the body', () => {
      const rendered = renderNotificationTemplate('odc_applicant_magic_link', {
        applicantName: 'Aina R.',
        programName: 'ODC 2026',
        magicLinkUrl: 'https://app.robiacopilot.site/odc/candidature/abc123',
      });
      expect(rendered.subject).toContain('ODC 2026');
      expect(rendered.text).toContain('Aina R.');
      expect(rendered.text).toContain(
        'https://app.robiacopilot.site/odc/candidature/abc123',
      );
    });
  });
});
