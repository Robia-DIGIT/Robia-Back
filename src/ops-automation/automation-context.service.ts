import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationConditionContext } from './condition-engine';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Builds the read-only, per-organization snapshot the condition engine
 * evaluates against. Every field here is either a count or a status derived
 * from ROBIA's own data — never a raw connection row, never a token.
 */
@Injectable()
export class AutomationContextService {
  constructor(private readonly prisma: PrismaService) {}

  async build(organizationId: string): Promise<AutomationConditionContext> {
    const [
      latestAudit,
      googleSearchConsoleConnection,
      metaConnection,
      openOpportunityCount,
      highPriorityOpportunityCount,
      websiteCount,
    ] = await Promise.all([
      this.prisma.audit.findFirst({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        select: { status: true, globalScore: true, createdAt: true },
      }),
      this.prisma.googleSearchConsoleConnection.findUnique({
        where: { organizationId },
        select: { id: true },
      }),
      this.prisma.metaConnection.findUnique({
        where: { organizationId },
        select: { id: true },
      }),
      this.prisma.opportunity.count({
        where: { organizationId, status: 'open' },
      }),
      this.prisma.opportunity.count({
        where: { organizationId, status: 'open', impactScore: { gte: 8 } },
      }),
      this.prisma.website.count({ where: { organizationId } }),
    ]);

    return {
      audit: {
        ageDays: latestAudit
          ? Math.floor(
              (Date.now() - latestAudit.createdAt.getTime()) / MS_PER_DAY,
            )
          : null,
        status: latestAudit?.status ?? null,
        globalScore: latestAudit?.globalScore ?? null,
      },
      integration: {
        googleSearchConsole: {
          status: googleSearchConsoleConnection ? 'connected' : 'disconnected',
        },
        meta: {
          status: metaConnection ? 'connected' : 'disconnected',
        },
      },
      opportunity: {
        count: openOpportunityCount,
        highPriorityCount: highPriorityOpportunityCount,
      },
      website: {
        count: websiteCount,
      },
    };
  }
}
