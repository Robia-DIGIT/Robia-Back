import { NotFoundException } from '@nestjs/common';
import { ActionItemsService } from './action-items/action-items.service';
import { AuditsService } from './audits/audits.service';
import { OrgScopeGuard } from './common/guards/org-scope.guard';
import { DocumentsService } from './documents/documents.service';
import { OpportunitiesService } from './opportunities/opportunities.service';
import { ValidationLogsService } from './validation-logs/validation-logs.service';
import { WebsitesService } from './websites/websites.service';

describe('Organization isolation', () => {
  const requestingOrganizationId = 'org-a';
  const foreignOrganizationId = 'org-b';

  it('derives the organization from the authenticated user and replaces client input', async () => {
    const prisma = {
      organization: {
        findFirst: jest.fn().mockResolvedValue({ id: requestingOrganizationId }),
      },
    };
    const request = {
      user: { userId: 'user-a', email: 'user-a@example.test' },
      organizationId: foreignOrganizationId,
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    };
    const guard = new OrgScopeGuard(prisma as any);

    await expect(guard.canActivate(context as any)).resolves.toBe(true);
    expect(prisma.organization.findFirst).toHaveBeenCalledWith({
      where: { ownerId: 'user-a' },
      select: { id: true },
    });
    expect(request.organizationId).toBe(requestingOrganizationId);
  });

  it('denies an authenticated user without an organization', async () => {
    const prisma = {
      organization: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const request = {
      user: { userId: 'user-without-org', email: 'none@example.test' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    };
    const guard = new OrgScopeGuard(prisma as any);

    await expect(guard.canActivate(context as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('does not return a website owned by another organization', async () => {
    const prisma = {
      website: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new WebsitesService(prisma as any);

    await expect(
      service.findOne(requestingOrganizationId, 'website-org-b'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.website.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'website-org-b',
        organizationId: requestingOrganizationId,
      },
    });
  });

  it('does not start an audit for a website owned by another organization', async () => {
    const prisma = {
      website: { findFirst: jest.fn().mockResolvedValue(null) },
      audit: { create: jest.fn() },
    };
    const runner = {
      runSiteAudit: jest.fn(),
      runAudit: jest.fn(),
    };
    const service = new AuditsService(prisma as any, runner as any);

    await expect(
      service.run(requestingOrganizationId, 'website-org-b'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.website.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'website-org-b',
        organizationId: requestingOrganizationId,
      },
    });
    expect(prisma.audit.create).not.toHaveBeenCalled();
    expect(runner.runSiteAudit).not.toHaveBeenCalled();
    expect(runner.runAudit).not.toHaveBeenCalled();
  });

  it('does not return an opportunity owned by another organization', async () => {
    const prisma = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new OpportunitiesService(prisma as any, {} as any);

    await expect(
      service.findOne(requestingOrganizationId, 'opportunity-org-b'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.opportunity.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'opportunity-org-b',
        organizationId: requestingOrganizationId,
      },
    });
  });

  it('does not update a document owned by another organization', async () => {
    const prisma = {
      document: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    const service = new DocumentsService(prisma as any, {} as any);

    await expect(
      service.update(requestingOrganizationId, 'document-org-b', {
        content: 'forbidden update',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.document.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'document-org-b',
        organizationId: requestingOrganizationId,
      },
    });
    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  it('does not update an action owned by another organization', async () => {
    const prisma = {
      actionItem: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    const service = new ActionItemsService(prisma as any, {} as any);

    await expect(
      service.updateStatus(requestingOrganizationId, 'action-org-b', {
        status: 'done',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.actionItem.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'action-org-b',
        organizationId: requestingOrganizationId,
      },
    });
    expect(prisma.actionItem.update).not.toHaveBeenCalled();
  });

  it('does not create a validation for a document owned by another organization', async () => {
    const prisma = {
      document: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      validationLog: { create: jest.fn() },
    };
    const service = new ValidationLogsService(prisma as any);

    await expect(
      service.create(requestingOrganizationId, 'user-a', {
        documentId: 'document-org-b',
        actionType: 'publish',
        platform: 'website',
        status: 'approved',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.document.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'document-org-b',
        organizationId: requestingOrganizationId,
      },
    });
    expect(prisma.validationLog.create).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
  });
});
