import { SeoIntelligenceAdapter } from './seo-intelligence.adapter';
import { PrismaService } from '../../prisma/prisma.service';

interface MockPrisma {
  audit: { findFirst: jest.Mock };
}

describe('SeoIntelligenceAdapter', () => {
  const organizationId = 'org-1';
  let prisma: MockPrisma;
  let adapter: SeoIntelligenceAdapter;

  beforeEach(() => {
    prisma = { audit: { findFirst: jest.fn() } };
    adapter = new SeoIntelligenceAdapter(prisma as unknown as PrismaService);
  });

  it('reports the existing seo_score_v2 verbatim, never recomputing it', async () => {
    const seoScoreV2 = {
      version: 'v2',
      globalScore: 75,
      categories: {
        technical: {
          score: 80,
          weight: 0.3,
          measured: true,
          findingsEvaluated: 4,
        },
      },
    };
    prisma.audit.findFirst.mockResolvedValue({
      id: 'audit-1',
      completedAt: new Date('2026-09-01T00:00:00.000Z'),
      resultJson: { site_audit: { seo_score_v2: seoScoreV2 } },
    });

    const signal = await adapter.collectSignal(organizationId);

    expect(signal.status).toBe('ok');
    expect(signal.scoreInfluence).toBe(true);
    // Byte-identical to what was already persisted — this adapter is a
    // read-only mirror, never a second scoring pass.
    expect(signal.data).toEqual(seoScoreV2);
  });

  it('reports unavailable with no_audit when the organization has no completed audit', async () => {
    prisma.audit.findFirst.mockResolvedValue(null);

    const signal = await adapter.collectSignal(organizationId);
    expect(signal.status).toBe('unavailable');
    expect(signal.data).toBeNull();
    expect(signal.unavailableReason).toBe('no_audit');
  });

  it('reports partial (never a fabricated ok) when an audit predates seo_score_v2', async () => {
    prisma.audit.findFirst.mockResolvedValue({
      id: 'audit-1',
      completedAt: new Date('2026-09-01T00:00:00.000Z'),
      resultJson: { global_score: 62 },
    });

    const signal = await adapter.collectSignal(organizationId);
    expect(signal.status).toBe('partial');
    expect(signal.data).toBeNull();
    expect(signal.unavailableReason).toBe('legacy_audit_result');
  });

  it('never generates any findings in RC-21 — the SEO opportunities pipeline stays untouched', async () => {
    const findings = await adapter.collectFindings();
    expect(findings).toEqual([]);
  });
});
