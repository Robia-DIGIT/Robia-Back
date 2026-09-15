import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IntelligenceController } from './intelligence.controller';
import { IntelligenceRegistryService } from './intelligence-registry.service';
import { PrismaService } from '../prisma/prisma.service';

interface MockPrisma {
  audit: { findFirst: jest.Mock };
}
interface MockRegistry {
  getStatus: jest.Mock;
  collectFindings: jest.Mock;
}
interface StubRequest {
  organizationId: string;
  user: { userId: string; email: string };
}

function stubRequest(
  organizationId: string,
): Parameters<IntelligenceController['getStatus']>[0] {
  const req: StubRequest = {
    organizationId,
    user: { userId: 'u1', email: 'a@b.c' },
  };
  return req as unknown as Parameters<IntelligenceController['getStatus']>[0];
}

describe('IntelligenceController', () => {
  const orgA = 'org-a';
  let prisma: MockPrisma;
  let registry: MockRegistry;
  let controller: IntelligenceController;

  beforeEach(() => {
    prisma = { audit: { findFirst: jest.fn() } };
    registry = { getStatus: jest.fn(), collectFindings: jest.fn() };
    controller = new IntelligenceController(
      registry as unknown as IntelligenceRegistryService,
      prisma as unknown as PrismaService,
    );
  });

  it('delegates GET /intelligence/status to the registry, scoped to the caller organization', async () => {
    registry.getStatus.mockResolvedValue([{ provider: 'seo', status: 'ok' }]);
    const req = stubRequest(orgA);

    const result = await controller.getStatus(req);

    expect(registry.getStatus).toHaveBeenCalledWith(orgA);
    expect(result).toEqual([{ provider: 'seo', status: 'ok' }]);
  });

  it('rejects GET /intelligence/findings without an auditId', async () => {
    const req = stubRequest(orgA);
    await expect(controller.getFindings(req, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.audit.findFirst).not.toHaveBeenCalled();
  });

  it('never lets organization A read findings for an audit owned by organization B (multi-tenant isolation)', async () => {
    // The mocked Prisma layer only "has" this audit under org B — the
    // lookup is scoped by (id, organizationId), so org A's request finds
    // nothing, exactly as if the audit did not exist.
    prisma.audit.findFirst.mockResolvedValue(null);
    const req = stubRequest(orgA);

    await expect(
      controller.getFindings(req, 'audit-owned-by-org-b'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.audit.findFirst).toHaveBeenCalledWith({
      where: { id: 'audit-owned-by-org-b', organizationId: orgA },
      select: { id: true, resultJson: true },
    });
    expect(registry.collectFindings).not.toHaveBeenCalled();
  });

  it('scopes GET /intelligence/findings to the audit resolved for the caller organization', async () => {
    prisma.audit.findFirst.mockResolvedValue({
      id: 'audit-1',
      resultJson: { global_score: 62 },
    });
    registry.collectFindings.mockResolvedValue([]);
    const req = stubRequest(orgA);

    await controller.getFindings(req, 'audit-1');

    expect(registry.collectFindings).toHaveBeenCalledWith(orgA, {
      auditId: 'audit-1',
      auditResult: { global_score: 62 },
    });
  });
});
