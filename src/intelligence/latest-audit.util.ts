import { PrismaService } from '../prisma/prisma.service';

/**
 * RC-21 — shared, read-only lookup used by the SEO and PageSpeed adapters:
 * both need "the org's most recent completed audit's resultJson", never a
 * second external call. Centralized here so both adapters share the exact
 * same never-throws guarantee and query shape, rather than two
 * independently-drifting copies.
 */
export interface LatestAuditSnapshot {
  id: string;
  completedAt: Date | null;
  resultJson: Record<string, unknown> | null;
}

export async function findLatestCompletedAudit(
  prisma: PrismaService,
  organizationId: string,
): Promise<LatestAuditSnapshot | null> {
  try {
    const audit = await prisma.audit.findFirst({
      where: { organizationId, status: 'completed' },
      orderBy: { completedAt: 'desc' },
      select: { id: true, completedAt: true, resultJson: true },
    });
    return audit
      ? {
          id: audit.id,
          completedAt: audit.completedAt,
          resultJson:
            (audit.resultJson as Record<string, unknown> | null) ?? null,
        }
      : null;
  } catch {
    // Degrade to "nothing found" rather than propagate — a transient DB
    // hiccup while collecting this side-signal must never fail the whole
    // /intelligence/status read or opportunity generation.
    return null;
  }
}
