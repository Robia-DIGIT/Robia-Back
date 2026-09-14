import {
  DEFAULT_META_INSIGHTS_THRESHOLDS,
  evaluateMetaFindings,
} from './meta-insights';
import { MetaAuditSignals } from './meta.service';

function baseSignals(
  overrides: Partial<MetaAuditSignals> = {},
): MetaAuditSignals {
  return {
    status: 'ok',
    source: 'meta',
    readOnly: true,
    scoreInfluence: false,
    connected: true,
    pageSelected: true,
    instagramLinked: true,
    facebook: { fanCount: 120, followersCount: 118, talkingAboutCount: 4 },
    instagram: { followersCount: 340, followsCount: 210, mediaCount: 12 },
    recentMedia: { observed: true, items: [] },
    lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
    unavailableReason: null,
    ...overrides,
  };
}

describe('evaluateMetaFindings', () => {
  it('is deterministic: the same signals always produce the same findings', () => {
    const signals = baseSignals({
      recentMedia: {
        observed: true,
        items: [
          {
            timestamp: '2026-09-10T00:00:00.000Z',
            likeCount: 3,
            commentsCount: 1,
          },
        ],
      },
    });
    const now = new Date('2026-09-14T00:00:00.000Z');

    const first = evaluateMetaFindings(
      signals,
      DEFAULT_META_INSIGHTS_THRESHOLDS,
      now,
    );
    const second = evaluateMetaFindings(
      signals,
      DEFAULT_META_INSIGHTS_THRESHOLDS,
      now,
    );

    expect(first).toEqual(second);
  });

  it('reports nothing when Meta is not connected at all', () => {
    const signals = baseSignals({
      status: 'unavailable',
      connected: false,
      pageSelected: false,
      instagramLinked: false,
      facebook: null,
      instagram: null,
      recentMedia: null,
      unavailableReason: 'not_connected',
    });

    expect(evaluateMetaFindings(signals)).toEqual([]);
  });

  it('fires META_PAGE_NOT_SELECTED, and only that rule, when connected without a selected Page', () => {
    const signals = baseSignals({
      status: 'unavailable',
      pageSelected: false,
      instagramLinked: false,
      facebook: null,
      instagram: null,
      recentMedia: null,
      unavailableReason: 'no_page_selected',
    });

    const findings = evaluateMetaFindings(signals);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: 'meta',
      ruleCode: 'META_PAGE_NOT_SELECTED',
      scoreInfluence: false,
      confidence: 'observed',
    });
  });

  it('fires META_INSTAGRAM_NOT_LINKED when a Page is selected but no Instagram account is linked', () => {
    const signals = baseSignals({
      instagramLinked: false,
      instagram: null,
      recentMedia: null,
    });

    const findings = evaluateMetaFindings(signals);

    expect(findings.map((f) => f.ruleCode)).toEqual([
      'META_INSTAGRAM_NOT_LINKED',
    ]);
    expect(findings[0].scoreInfluence).toBe(false);
    expect(findings[0].evidence.length).toBeGreaterThan(0);
  });

  it('fires META_NO_RECENT_MEDIA when Instagram is linked and genuinely has zero media', () => {
    const signals = baseSignals({
      recentMedia: { observed: true, items: [] },
    });

    const findings = evaluateMetaFindings(signals);

    expect(findings.map((f) => f.ruleCode)).toEqual(['META_NO_RECENT_MEDIA']);
  });

  it('never fires META_NO_RECENT_MEDIA when the media read itself failed (permissions/API), not a genuine empty list', () => {
    const signals = baseSignals({
      recentMedia: { observed: false, items: [] },
    });

    const findings = evaluateMetaFindings(signals);

    expect(findings.map((f) => f.ruleCode)).not.toContain(
      'META_NO_RECENT_MEDIA',
    );
    expect(findings.map((f) => f.ruleCode)).not.toContain(
      'META_LOW_RECENT_ACTIVITY',
    );
  });

  it('fires META_LOW_RECENT_ACTIVITY, marked heuristic, below the configured post threshold', () => {
    const now = new Date('2026-09-14T00:00:00.000Z');
    const signals = baseSignals({
      recentMedia: {
        observed: true,
        items: [
          // 60 days old — outside the default 30-day window.
          {
            timestamp: '2026-07-16T00:00:00.000Z',
            likeCount: 5,
            commentsCount: 2,
          },
        ],
      },
    });

    const findings = evaluateMetaFindings(
      signals,
      DEFAULT_META_INSIGHTS_THRESHOLDS,
      now,
    );

    expect(findings.map((f) => f.ruleCode)).toEqual([
      'META_LOW_RECENT_ACTIVITY',
    ]);
    expect(findings[0].confidence).toBe('heuristic');
    expect(findings[0].evidence[0].observed).toContain('0 publication');
  });

  it('does not fire META_LOW_RECENT_ACTIVITY once the configured threshold is met', () => {
    const now = new Date('2026-09-14T00:00:00.000Z');
    const signals = baseSignals({
      recentMedia: {
        observed: true,
        items: [
          {
            timestamp: '2026-09-10T00:00:00.000Z',
            likeCount: 5,
            commentsCount: 2,
          },
        ],
      },
    });

    const findings = evaluateMetaFindings(
      signals,
      DEFAULT_META_INSIGHTS_THRESHOLDS,
      now,
    );

    expect(findings.map((f) => f.ruleCode)).not.toContain(
      'META_LOW_RECENT_ACTIVITY',
    );
  });

  it('respects a custom, configured threshold instead of a hardcoded one', () => {
    const now = new Date('2026-09-14T00:00:00.000Z');
    const signals = baseSignals({
      recentMedia: {
        observed: true,
        items: [
          {
            timestamp: '2026-09-10T00:00:00.000Z',
            likeCount: 5,
            commentsCount: 2,
          },
        ],
      },
    });

    const findings = evaluateMetaFindings(
      signals,
      { lowActivityWindowDays: 30, lowActivityMinPosts: 5 },
      now,
    );

    expect(findings.map((f) => f.ruleCode)).toContain(
      'META_LOW_RECENT_ACTIVITY',
    );
  });

  it('ignores a post with an unparseable timestamp rather than assuming it is recent', () => {
    const now = new Date('2026-09-14T00:00:00.000Z');
    const signals = baseSignals({
      recentMedia: {
        observed: true,
        items: [{ timestamp: 'not-a-date', likeCount: 5, commentsCount: 2 }],
      },
    });

    const findings = evaluateMetaFindings(
      signals,
      DEFAULT_META_INSIGHTS_THRESHOLDS,
      now,
    );

    expect(findings.map((f) => f.ruleCode)).toContain(
      'META_LOW_RECENT_ACTIVITY',
    );
  });

  it('fires META_PROFILE_DATA_INCOMPLETE only when the Page read succeeded but both counters are genuinely null', () => {
    const signals = baseSignals({
      facebook: {
        fanCount: null,
        followersCount: null,
        talkingAboutCount: null,
      },
    });

    const findings = evaluateMetaFindings(signals);

    expect(findings.map((f) => f.ruleCode)).toContain(
      'META_PROFILE_DATA_INCOMPLETE',
    );
  });

  it('does not fire META_PROFILE_DATA_INCOMPLETE when at least one counter is present', () => {
    const signals = baseSignals({
      facebook: { fanCount: 42, followersCount: null, talkingAboutCount: null },
    });

    const findings = evaluateMetaFindings(signals);

    expect(findings.map((f) => f.ruleCode)).not.toContain(
      'META_PROFILE_DATA_INCOMPLETE',
    );
  });

  it('never invents a metric: every finding evidence string only quotes counts actually present in the signals', () => {
    const signals = baseSignals({
      instagramLinked: false,
      instagram: null,
      recentMedia: null,
      facebook: {
        fanCount: null,
        followersCount: null,
        talkingAboutCount: null,
      },
    });

    const findings = evaluateMetaFindings(signals);
    const serialized = JSON.stringify(findings);

    // No invented follower/engagement/growth/revenue figure anywhere.
    expect(serialized).not.toMatch(
      /\b\d+\s*(followers|abonnés|engagement|revenus?|chiffre d'affaires)\b/i,
    );
    findings.forEach((finding) => {
      expect(finding.scoreInfluence).toBe(false);
      expect(finding.source).toBe('meta');
    });
  });

  it('produces every field the product contract requires for a Meta finding', () => {
    const signals = baseSignals({
      instagramLinked: false,
      instagram: null,
      recentMedia: null,
    });

    const [finding] = evaluateMetaFindings(signals);

    expect(finding.source).toBe('meta');
    expect(typeof finding.ruleCode).toBe('string');
    expect(typeof finding.title).toBe('string');
    expect(typeof finding.description).toBe('string');
    expect(Array.isArray(finding.evidence)).toBe(true);
    expect(typeof finding.recommendation).toBe('string');
    expect(['observed', 'heuristic']).toContain(finding.confidence);
    expect(finding.scoreInfluence).toBe(false);
  });

  it("keeps every rule's impact/effort on the same 0-10 scale as SEO findings — never a different scale that could distort ranking (Codex review)", () => {
    // python-service/app/agents/audit_rules.py assigns impact_score/
    // effort_score as small ints in [0, 10] (e.g. 4, 5, 6, 8, 9) for every
    // SEO finding. oppPriorityScore()'s frontend fallback
    // (impactScore * 10) and findAllForAudit()'s top-5 ranking both
    // assume that scale uniformly across every opportunity source — a
    // Meta finding using a different scale would silently distort both.
    const scenarios: MetaAuditSignals[] = [
      baseSignals({
        status: 'unavailable',
        connected: true,
        pageSelected: false,
        instagramLinked: false,
        facebook: null,
        instagram: null,
        recentMedia: null,
        unavailableReason: 'no_page_selected',
      }),
      baseSignals({
        instagramLinked: false,
        instagram: null,
        recentMedia: null,
      }),
      baseSignals({ recentMedia: { observed: true, items: [] } }),
      baseSignals({
        recentMedia: {
          observed: true,
          items: [
            {
              timestamp: '2026-07-16T00:00:00.000Z',
              likeCount: 1,
              commentsCount: 0,
            },
          ],
        },
      }),
      baseSignals({
        facebook: {
          fanCount: null,
          followersCount: null,
          talkingAboutCount: null,
        },
      }),
    ];

    const allFindings = scenarios.flatMap((signals) =>
      evaluateMetaFindings(
        signals,
        DEFAULT_META_INSIGHTS_THRESHOLDS,
        new Date('2026-09-14T00:00:00.000Z'),
      ),
    );

    expect(allFindings.length).toBeGreaterThanOrEqual(5);
    allFindings.forEach((finding) => {
      expect(finding.impactScore).toBeGreaterThanOrEqual(0);
      expect(finding.impactScore).toBeLessThanOrEqual(10);
      expect(finding.effortScore).toBeGreaterThanOrEqual(0);
      expect(finding.effortScore).toBeLessThanOrEqual(10);
      expect(Number.isInteger(finding.impactScore)).toBe(true);
      expect(Number.isInteger(finding.effortScore)).toBe(true);
    });
  });

  it('does not fire META_LOW_RECENT_ACTIVITY when the observed post count exactly meets a threshold at the 10-item fetch ceiling', () => {
    // Clamping the *configured* threshold to that ceiling is
    // MetaService.getInsightsThresholds()'s job (see
    // meta-insights-signals.spec.ts) — this only proves the comparison
    // itself is a plain >= at the boundary, not an off-by-one.
    const now = new Date('2026-09-14T00:00:00.000Z');
    const signals = baseSignals({
      recentMedia: {
        observed: true,
        items: Array.from({ length: 10 }, (_, i) => ({
          timestamp: new Date(
            now.getTime() - i * 24 * 60 * 60 * 1000,
          ).toISOString(),
          likeCount: 1,
          commentsCount: 0,
        })),
      },
    });

    const findings = evaluateMetaFindings(
      signals,
      { lowActivityWindowDays: 30, lowActivityMinPosts: 10 },
      now,
    );

    expect(findings.map((f) => f.ruleCode)).not.toContain(
      'META_LOW_RECENT_ACTIVITY',
    );
  });
});
