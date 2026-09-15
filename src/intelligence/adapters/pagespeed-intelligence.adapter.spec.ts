import { PageSpeedIntelligenceAdapter } from './pagespeed-intelligence.adapter';
import { PrismaService } from '../../prisma/prisma.service';

interface MockPrisma {
  audit: { findFirst: jest.Mock };
}

describe('PageSpeedIntelligenceAdapter', () => {
  const organizationId = 'org-1';
  let prisma: MockPrisma;
  let adapter: PageSpeedIntelligenceAdapter;

  beforeEach(() => {
    prisma = { audit: { findFirst: jest.fn() } };
    adapter = new PageSpeedIntelligenceAdapter(
      prisma as unknown as PrismaService,
    );
  });

  it('never performs a second call to any Google API — only reads the already-persisted audit via Prisma', async () => {
    prisma.audit.findFirst.mockResolvedValue({
      id: 'audit-1',
      completedAt: new Date('2026-09-01T00:00:00.000Z'),
      resultJson: {
        site_audit: {
          pagespeed_insights: {
            status: 'ok',
            strategy: 'mobile',
            performanceScore: 82,
            metrics: { lcpMs: 1200, cls: 0.02, tbtMs: 50, fcpMs: 800 },
            fetchedAt: '2026-09-01T00:00:00.000Z',
            analyzedUrl: 'https://robiacopilot.site/',
            finalUrl: 'https://robiacopilot.site/',
            source: 'pagespeed-insights',
            unavailableReason: null,
          },
        },
      },
    });

    const signal = await adapter.collectSignal(organizationId);

    expect(prisma.audit.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.audit.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId, status: 'completed' },
      }),
    );
    expect(signal.status).toBe('ok');
    expect((signal.data as { performanceScore: number }).performanceScore).toBe(
      82,
    );
  });

  it('reports unavailable with reason no_audit when the organization has no completed audit', async () => {
    prisma.audit.findFirst.mockResolvedValue(null);

    const signal = await adapter.collectSignal(organizationId);

    expect(signal.status).toBe('unavailable');
    expect(signal.data).toBeNull();
    expect(signal.unavailableReason).toBe('no_audit');
  });

  it('reports unavailable with reason no_pagespeed_data when an audit exists but carries no PageSpeed evidence', async () => {
    prisma.audit.findFirst.mockResolvedValue({
      id: 'audit-1',
      completedAt: new Date(),
      resultJson: { site_audit: { pagespeed_insights: null } },
    });

    const signal = await adapter.collectSignal(organizationId);

    expect(signal.status).toBe('unavailable');
    expect(signal.data).toBeNull();
    expect(signal.unavailableReason).toBe('no_pagespeed_data');
  });

  it('degrades to no_audit rather than throwing when the Prisma read itself fails', async () => {
    prisma.audit.findFirst.mockRejectedValue(new Error('DB down'));

    const signal = await adapter.collectSignal(organizationId);

    expect(signal.status).toBe('unavailable');
    expect(signal.unavailableReason).toBe('no_audit');
  });

  it('never generates any findings in RC-21', async () => {
    const findings = await adapter.collectFindings();
    expect(findings).toEqual([]);
  });
});
